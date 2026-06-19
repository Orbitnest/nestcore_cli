import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Sql } from './migrate';

/**
 * `orbitnest db diff` — drift detection. Introspect the live `public` schema
 * (tables + columns), compare against a committed baseline snapshot
 * (`.orbitnest/schema.snapshot.json`), and report what changed. This avoids the
 * pitfalls of generating DDL — it answers "did the live schema drift from what
 * we last recorded?", which is the day-to-day need in a migration workflow.
 */

export interface ColumnSnapshot {
  type: string;
  nullable: boolean;
  default: string | null;
}
export interface TableSnapshot {
  columns: Record<string, ColumnSnapshot>;
}
export interface SchemaSnapshot {
  generatedAt?: string;
  tables: Record<string, TableSnapshot>;
}

export const SNAPSHOT_PATH = join('.orbitnest', 'schema.snapshot.json');

interface ColRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name?: string;
  is_nullable: string;
  column_default: string | null;
}

/** Read the live schema into a normalized snapshot (same table filter as gen types). */
export async function introspectSchema(sql: Sql): Promise<SchemaSnapshot> {
  const { rows } = await sql(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name NOT LIKE 'auth\\_%'
        AND table_name NOT LIKE 'pg\\_%'
        AND table_name NOT LIKE '\\_%'
      ORDER BY table_name, ordinal_position`,
  );
  const tables: Record<string, TableSnapshot> = {};
  for (const r of rows as ColRow[]) {
    const t = (tables[r.table_name] ??= { columns: {} });
    // information_schema reports arrays as data_type 'ARRAY' with udt_name '_int4' etc.
    const type = r.data_type === 'ARRAY' && r.udt_name ? r.udt_name : r.data_type;
    t.columns[r.column_name] = {
      type,
      nullable: r.is_nullable === 'YES',
      default: r.column_default ?? null,
    };
  }
  return { generatedAt: new Date().toISOString(), tables };
}

export function loadSnapshot(): SchemaSnapshot | null {
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as SchemaSnapshot;
  } catch {
    return null;
  }
}

export function saveSnapshot(snapshot: SchemaSnapshot): string {
  mkdirSync('.orbitnest', { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
  return SNAPSHOT_PATH;
}

export interface ColumnChange {
  column: string;
  before: ColumnSnapshot;
  after: ColumnSnapshot;
}
export interface TableChange {
  table: string;
  addedColumns: string[];
  removedColumns: string[];
  changedColumns: ColumnChange[];
}
export interface SchemaDiff {
  addedTables: string[];
  removedTables: string[];
  changedTables: TableChange[];
}

/** Structural diff: what does `current` have that `base` doesn't (and vice-versa)? */
export function diffSnapshots(base: SchemaSnapshot, current: SchemaSnapshot): SchemaDiff {
  const baseTables = base.tables ?? {};
  const curTables = current.tables ?? {};
  const addedTables = Object.keys(curTables).filter((t) => !baseTables[t]).sort();
  const removedTables = Object.keys(baseTables).filter((t) => !curTables[t]).sort();

  const changedTables: TableChange[] = [];
  for (const t of Object.keys(curTables).filter((x) => baseTables[x]).sort()) {
    const b = baseTables[t].columns ?? {};
    const c = curTables[t].columns ?? {};
    const addedColumns = Object.keys(c).filter((k) => !b[k]).sort();
    const removedColumns = Object.keys(b).filter((k) => !c[k]).sort();
    const changedColumns: ColumnChange[] = [];
    for (const col of Object.keys(c).filter((k) => b[k]).sort()) {
      const before = b[col];
      const after = c[col];
      if (before.type !== after.type || before.nullable !== after.nullable || before.default !== after.default) {
        changedColumns.push({ column: col, before, after });
      }
    }
    if (addedColumns.length || removedColumns.length || changedColumns.length) {
      changedTables.push({ table: t, addedColumns, removedColumns, changedColumns });
    }
  }
  return { addedTables, removedTables, changedTables };
}

export function hasChanges(d: SchemaDiff): boolean {
  return d.addedTables.length > 0 || d.removedTables.length > 0 || d.changedTables.length > 0;
}

/** Compact one-line description of a column for the diff output. */
export function describeColumn(c: ColumnSnapshot): string {
  return `${c.type}${c.nullable ? ' null' : ' not null'}${c.default ? ` default ${c.default}` : ''}`;
}
