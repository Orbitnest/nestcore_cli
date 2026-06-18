import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

/** Runs SQL and returns rows. Injected so the engine stays transport-agnostic. */
export type Sql = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

const FILE_RE = /^(\d+)[_-](.+)\.sql$/i;
const DOWN_RE = /^\s*--+\s*(migrate:)?down\b.*$/i;

const REGISTRY_DDL = `
CREATE TABLE IF NOT EXISTS migrations (
  migration_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  executed_at TIMESTAMP DEFAULT NOW(),
  status TEXT NOT NULL
);`;

export interface MigFile {
  id: string;
  name: string;
  path: string;
  up: string;
  down: string;
  checksum: string;
}

function splitUpDown(content: string): { up: string; down: string } {
  const lines = content.split(/\r?\n/);
  const i = lines.findIndex((l) => DOWN_RE.test(l));
  return i === -1 ? { up: content, down: '' } : { up: lines.slice(0, i).join('\n'), down: lines.slice(i + 1).join('\n') };
}

export function scan(dir: string): MigFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(`Cannot read migrations directory "${dir}". Create it or pass --dir.`);
  }
  const files = entries
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .map((f): MigFile | null => {
      const m = FILE_RE.exec(f);
      if (!m) return null;
      const path = join(dir, f);
      const content = readFileSync(path, 'utf8');
      const { up, down } = splitUpDown(content);
      return { id: m[1], name: f, path, up, down, checksum: createHash('sha256').update(content, 'utf8').digest('hex') };
    })
    .filter((x): x is MigFile => x !== null)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.id)) throw new Error(`Duplicate migration id "${f.id}" — prefixes must be unique.`);
    seen.add(f.id);
  }
  return files;
}

async function applied(sql: Sql): Promise<Map<string, any>> {
  const { rows } = await sql('SELECT migration_id, name, checksum, status FROM migrations ORDER BY migration_id');
  const m = new Map<string, any>();
  for (const r of rows) m.set(r.migration_id, r);
  return m;
}

async function runScript(sql: Sql, body: string): Promise<void> {
  const b = body.trim();
  if (!b) return;
  const terminated = b.endsWith(';') ? b : `${b};`;
  await sql(`BEGIN;\n${terminated}\nCOMMIT;`);
}

async function record(sql: Sql, f: MigFile, status: 'success' | 'failed'): Promise<void> {
  await sql(
    `INSERT INTO migrations (migration_id, name, checksum, status, executed_at)
          VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (migration_id) DO UPDATE
          SET name = EXCLUDED.name, checksum = EXCLUDED.checksum, status = EXCLUDED.status, executed_at = NOW()`,
    [f.id, f.name, f.checksum, status],
  );
}

export interface StatusEntry {
  id: string;
  name: string;
  status: string;
  applied: boolean;
  mismatch: boolean;
}

export async function status(sql: Sql, dir: string): Promise<StatusEntry[]> {
  await sql(REGISTRY_DDL);
  const files = scan(dir);
  const ap = await applied(sql);
  return files.map((f) => {
    const r = ap.get(f.id);
    return {
      id: f.id,
      name: f.name,
      status: r ? r.status : 'pending',
      applied: r?.status === 'success',
      mismatch: r?.status === 'success' && r.checksum !== f.checksum,
    };
  });
}

export async function push(sql: Sql, dir: string): Promise<{ ran: string[]; skipped: string[] }> {
  await sql(REGISTRY_DDL);
  const files = scan(dir);
  const ap = await applied(sql);
  const ran: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const r = ap.get(f.id);
    if (r?.status === 'success') {
      if (r.checksum !== f.checksum) {
        throw new Error(`Migration "${f.name}" was modified after being applied (checksum mismatch). Add a new migration instead.`);
      }
      skipped.push(f.id);
      continue;
    }
    try {
      await runScript(sql, f.up);
      await record(sql, f, 'success');
      ran.push(f.id);
    } catch (e) {
      await record(sql, f, 'failed').catch(() => undefined);
      throw new Error(`Migration "${f.name}" failed and was rolled back: ${(e as Error).message}`);
    }
  }
  return { ran, skipped };
}

export async function rollback(sql: Sql, dir: string, id?: string): Promise<string> {
  await sql(REGISTRY_DDL);
  const files = scan(dir);
  const ap = await applied(sql);
  let target: MigFile | undefined;
  if (id) {
    target = files.find((f) => f.id === id);
    if (!target) throw new Error(`Migration "${id}" not found.`);
    if (ap.get(id)?.status !== 'success') throw new Error(`Migration "${id}" is not currently applied.`);
  } else {
    const appliedFiles = files.filter((f) => ap.get(f.id)?.status === 'success');
    target = appliedFiles[appliedFiles.length - 1];
    if (!target) throw new Error('There are no applied migrations to roll back.');
  }
  if (!target.down.trim()) throw new Error(`Migration "${target.name}" has no \`-- migrate:down\` section.`);
  await runScript(sql, target.down);
  await sql('DELETE FROM migrations WHERE migration_id = $1', [target.id]);
  return target.id;
}

/**
 * Drop all user tables in the public schema (leaving internal `auth_*`, `pg_*`,
 * and `_*` tables untouched), then re-apply every migration from scratch.
 * Destructive — the caller must confirm first.
 */
export async function reset(sql: Sql, dir: string): Promise<{ dropped: string[]; ran: string[] }> {
  const { rows } = await sql(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT LIKE 'auth\\_%'
        AND tablename NOT LIKE 'pg\\_%'
        AND tablename NOT LIKE '\\_%'
      ORDER BY tablename`,
  );
  const dropped: string[] = [];
  for (const r of rows) {
    const t = r.tablename as string;
    if (!t || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) continue;
    await sql(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    dropped.push(t);
  }
  // `push` recreates the (now-dropped) migrations registry and runs everything.
  const { ran } = await push(sql, dir);
  return { dropped, ran };
}

export function createMigration(dir: string, name: string): { id: string; path: string } {
  mkdirSync(dir, { recursive: true });
  let existing: string[] = [];
  try {
    existing = readdirSync(dir).filter((f) => /^\d+[_-].+\.sql$/i.test(f));
  } catch {
    /* empty */
  }
  const maxId = existing.reduce((m, f) => Math.max(m, parseInt(f, 10) || 0), 0);
  const id = String(maxId + 1).padStart(3, '0');
  const safe = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'migration';
  const path = join(dir, `${id}_${safe}.sql`);
  writeFileSync(
    path,
    `-- Migration ${id}: ${name}\n-- Forward (up) SQL — applied by \`orbitnest db push\`.\n\n\n` +
      `-- migrate:down\n-- Rollback SQL — applied by \`orbitnest db rollback\`. Optional but recommended.\n`,
    { flag: 'wx' },
  );
  return { id, path };
}
