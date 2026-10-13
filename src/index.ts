import { readFileSync, writeFileSync } from 'fs';
import * as readline from 'readline';
import {
  Api,
  ApiError,
  apiUrl,
  authed,
  jwtExpiry,
  loadCredentials,
  loadLink,
  matchProject,
  resolveProjectId,
  saveCredentials,
  saveLink,
} from './context';
import type { Sql } from './migrate';
import * as mig from './migrate';
import { generateTypes } from './typegen';
import {
  introspectSchema,
  loadSnapshot,
  saveSnapshot,
  diffSnapshots,
  hasChanges,
  describeColumn,
  SNAPSHOT_PATH,
} from './schema-diff';
import { color, ExitSignal, fail, heading, info, log, success, table, warn } from './ui';
import pkg from '../package.json';

const VERSION: string = pkg.version;

// ── arg parsing ──────────────────────────────────────────────────────────────
const ALIAS: Record<string, string> = {
  o: 'out', f: 'file', p: 'project', d: 'dir', h: 'help', v: 'version', e: 'email',
};

function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      if (body.includes('=')) {
        const [k, ...v] = body.split('=');
        flags[k] = v.join('=');
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[body] = argv[++i];
      } else flags[body] = true;
    } else if (tok.startsWith('-') && tok.length > 1) {
      const k = ALIAS[tok.slice(1)] ?? tok.slice(1);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positionals.push(tok);
  }
  return { positionals, flags };
}

const str = (flags: Record<string, string | boolean>, k: string): string | undefined =>
  typeof flags[k] === 'string' ? (flags[k] as string) : undefined;

// ── prompts ──────────────────────────────────────────────────────────────────
function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    fail('Cannot prompt for a password without a TTY. Use --password or ORBITNEST_PASSWORD.');
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch: string) => {
      const code = ch.charCodeAt(0);
      if (code === 13 || code === 10 || code === 4) {
        // Enter / Ctrl-D — submit
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write(String.fromCharCode(10));
        resolve(value);
      } else if (code === 3) {
        // Ctrl-C — abort
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write(String.fromCharCode(10));
        reject(new ExitSignal(1));
      } else if (code === 127 || code === 8) {
        // Backspace / DEL
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────
function sqlRunner(api: Api, projectId: string): Sql {
  return async (sql, params) => {
    const r = await api.post<any>(
      `/projects/${encodeURIComponent(projectId)}/database/sql`,
      params && params.length ? { sql, params } : { sql },
    );
    const rows = Array.isArray(r?.data) ? r.data : (r?.data?.rows ?? r?.rows ?? []);
    return { rows };
  };
}

function listFrom(res: any): any[] {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.data)) return res.data;
  if (Array.isArray(res?.projects)) return res.projects;
  return [];
}

// ── commands ─────────────────────────────────────────────────────────────────
async function cmdLogin(flags: Record<string, string | boolean>) {
  const url = str(flags, 'url') || apiUrl();
  const email = str(flags, 'email') || process.env.ORBITNEST_EMAIL || (await promptLine('Email: '));
  const password = str(flags, 'password') || process.env.ORBITNEST_PASSWORD || (await promptSecret('Password: '));
  if (!email || !password) fail('Email and password are required.');

  const api = new Api(url);
  let res: any;
  try {
    res = await api.post<any>('/auth/signin', { email, password }, { noAuth: true });
  } catch (e) {
    fail(`Login failed: ${(e as ApiError).message}`);
  }

  // MFA step-up: when the admin has two-factor enabled, signin returns a
  // short-lived challenge instead of tokens. Complete it with a TOTP code (or a
  // recovery code) via POST /auth/signin/mfa.
  if (res?.mfa_required ?? res?.data?.mfa_required) {
    const challengeToken = res.challenge_token ?? res.data?.challenge_token;
    let code = str(flags, 'code') || process.env.ORBITNEST_MFA_CODE;
    if (!code) {
      if (!process.stdin.isTTY) {
        fail('This account has two-factor enabled. Pass --code <code> or set ORBITNEST_MFA_CODE.');
      }
      code = await promptLine('Two-factor code (authenticator or recovery code): ');
    }
    if (!code) fail('A two-factor code is required to finish signing in.');
    try {
      res = await api.post<any>(
        '/auth/signin/mfa',
        { challenge_token: challengeToken, code: code.trim() },
        { noAuth: true },
      );
    } catch (e) {
      fail(`Two-factor verification failed: ${(e as ApiError).message}`);
    }
  }

  const access = res.access_token ?? res.data?.access_token;
  const refresh = res.refresh_token ?? res.data?.refresh_token;
  const user = res.user ?? res.data?.user;
  if (!access) fail('Login succeeded but no access token was returned by the server.');
  saveCredentials({ apiUrl: url, access_token: access, refresh_token: refresh, expires_at: jwtExpiry(access), user });
  success(`Logged in as ${color.bold(user?.email ?? email)} (${url})`);
}

async function cmdLogout() {
  const creds = loadCredentials();
  if (creds.refresh_token && creds.access_token) {
    try {
      // The access token is usually expired (15 min); this call refreshes it
      // through the shared refresher. Signout then sends the CURRENT refresh
      // token — a rotated-away one would match no session and revoke nothing.
      const api = authed();
      await api.get('/auth/profile');
      await api.post('/auth/signout', { refresh_token: loadCredentials().refresh_token });
    } catch (e) {
      warn(`Could not revoke the server session (${(e as Error).message}); it expires on its own within 7 days.`);
    }
  }
  saveCredentials({ apiUrl: creds.apiUrl });
  success('Logged out.');
}

async function cmdWhoami() {
  const creds = loadCredentials();
  if (!creds.access_token) { warn('Not logged in. Run `orbitnest login`.'); return; }
  try {
    const me = await authed().get<any>('/auth/profile');
    const u = me.user ?? me.data ?? me;
    success(`Logged in as ${color.bold(u.email ?? creds.user?.email ?? 'unknown')}`);
    log(color.dim(`  API: ${apiUrl()}`));
    if (creds.expires_at) log(color.dim(`  token expires: ${creds.expires_at}`));
  } catch (e) {
    warn(`Session check failed (${(e as ApiError).message}). Try \`orbitnest login\`.`);
  }
}

async function cmdProjects() {
  const projects = listFrom(await authed().get<any>('/projects'));
  heading(`Projects (${projects.length})`);
  table(
    projects.map((p) => ({ name: String(p.name ?? ''), slug: String(p.slug ?? ''), id: String(p.id ?? '') })),
    ['name', 'slug', 'id'],
  );
}

async function cmdLink(positionals: string[]) {
  const ref = positionals[0];
  const projects = listFrom(await authed().get<any>('/projects'));
  if (!ref) {
    if (projects.length === 1) {
      const p = projects[0];
      saveLink({ projectId: p.id, projectSlug: p.slug, name: p.name, apiUrl: apiUrl() });
      success(`Linked to ${color.bold(p.name)} (${p.slug}).`);
      return;
    }
    heading('Specify a project to link: `orbitnest link <id|slug>`');
    table(projects.map((p) => ({ name: String(p.name ?? ''), slug: String(p.slug ?? '') })), ['name', 'slug']);
    return;
  }
  const match = matchProject(projects, ref);
  saveLink({ projectId: match.id, projectSlug: match.slug, name: match.name, apiUrl: apiUrl() });
  success(`Linked this directory to ${color.bold(match.name)} (${match.slug}).`);
  log(color.dim('  Wrote .orbitnest/config.json'));
}

function cmdMigrationNew(positionals: string[], flags: Record<string, string | boolean>) {
  const name = positionals.join(' ').trim();
  if (!name) fail('Usage: orbitnest migration new <name>');
  const dir = str(flags, 'dir') || 'migrations';
  const { id, path } = mig.createMigration(dir, name);
  success(`Created migration ${color.bold(id)}: ${path}`);
}

async function cmdDbPush(flags: Record<string, string | boolean>) {
  const api = authed();
  const { id } = await resolveProjectId(api, str(flags, 'project'));
  const dir = str(flags, 'dir') || 'migrations';
  const sql = sqlRunner(api, id);
  const res = await mig.push(sql, dir);
  if (res.ran.length === 0) success(`Up to date — ${res.skipped.length} migration(s) already applied.`);
  else success(`Applied ${res.ran.length} migration(s): ${res.ran.join(', ')}${res.skipped.length ? color.dim(` (skipped ${res.skipped.length})`) : ''}`);
}

async function cmdDbStatus(flags: Record<string, string | boolean>) {
  const api = authed();
  const { id } = await resolveProjectId(api, str(flags, 'project'));
  const dir = str(flags, 'dir') || 'migrations';
  const entries = await mig.status(sqlRunner(api, id), dir);
  heading(`Migrations (${entries.filter((e) => e.applied).length}/${entries.length} applied)`);
  table(
    entries.map((e) => ({
      id: e.id,
      name: e.name,
      status: e.mismatch
        ? color.red('modified')
        : e.applied
          ? color.green('applied')
          : e.status === 'failed'
            ? color.red('failed')
            : color.dim('pending'),
    })),
    ['id', 'name', 'status'],
  );
}

async function cmdDbRollback(positionals: string[], flags: Record<string, string | boolean>) {
  const api = authed();
  const { id } = await resolveProjectId(api, str(flags, 'project'));
  const dir = str(flags, 'dir') || 'migrations';
  const rolled = await mig.rollback(sqlRunner(api, id), dir, positionals[0]);
  success(`Rolled back migration ${color.bold(rolled)}.`);
}

async function cmdDbReset(flags: Record<string, string | boolean>) {
  const api = authed();
  const { id } = await resolveProjectId(api, str(flags, 'project'));
  const dir = str(flags, 'dir') || 'migrations';
  if (!flags.yes && !flags.force) {
    fail('`db reset` DROPS every table in your project and re-runs all migrations. Re-run with --yes to confirm.');
  }
  warn('Resetting database — dropping all tables and re-applying migrations…');
  const res = await mig.reset(sqlRunner(api, id), dir);
  success(
    `Dropped ${res.dropped.length} table(s); applied ${res.ran.length} migration(s).` +
      (res.dropped.length ? color.dim(`\n  dropped: ${res.dropped.join(', ')}`) : ''),
  );
}

async function cmdDbSql(positionals: string[], flags: Record<string, string | boolean>) {
  const api = authed();
  const { id } = await resolveProjectId(api, str(flags, 'project'));
  const file = str(flags, 'file');
  const sqlText = file ? readFileSync(file, 'utf8') : positionals.join(' ');
  if (!sqlText.trim()) fail('Usage: orbitnest db sql "<SQL>"  (or --file <path>)');
  const { rows } = await sqlRunner(api, id)(sqlText);
  log(JSON.stringify(rows, null, 2));
  log(color.dim(`\n${rows.length} row(s)`));
}

async function cmdGenTypes(flags: Record<string, string | boolean>) {
  const api = authed();
  const { id } = await resolveProjectId(api, str(flags, 'project'));
  const ts = await generateTypes(sqlRunner(api, id));
  if (flags.stdout) { process.stdout.write(ts); return; }
  const out = str(flags, 'out') || 'orbitnest.types.ts';
  writeFileSync(out, ts);
  success(`Wrote TypeScript types → ${color.bold(out)}`);
}

async function cmdDbDiff(flags: Record<string, string | boolean>) {
  const api = authed();
  const { id } = await resolveProjectId(api, str(flags, 'project'));
  const current = await introspectSchema(sqlRunner(api, id));

  // `--save` captures the live schema as the new baseline.
  if (flags.save) {
    const path = saveSnapshot(current);
    success(`Saved schema snapshot (${Object.keys(current.tables).length} table(s)) → ${color.bold(path)}`);
    return;
  }

  const base = loadSnapshot();
  if (!base) {
    fail(`No schema snapshot found (${SNAPSHOT_PATH}). Run \`orbitnest db diff --save\` to capture the current schema as a baseline.`);
  }

  const diff = diffSnapshots(base!, current);
  if (!hasChanges(diff)) {
    success('No schema drift — the live schema matches the snapshot.');
    return;
  }

  heading('Schema drift vs snapshot');
  for (const t of diff.addedTables) log(color.green(`+ table ${t}`));
  for (const t of diff.removedTables) log(color.red(`- table ${t}`));
  for (const ct of diff.changedTables) {
    log(color.yellow(`~ table ${ct.table}`));
    for (const c of ct.addedColumns) {
      log(color.green(`    + ${c}  ${color.dim(describeColumn(current.tables[ct.table].columns[c]))}`));
    }
    for (const c of ct.removedColumns) log(color.red(`    - ${c}`));
    for (const cc of ct.changedColumns) {
      log(color.yellow(`    ~ ${cc.column}: ${color.dim(describeColumn(cc.before))} → ${color.dim(describeColumn(cc.after))}`));
    }
  }
  log(color.dim('\nUpdate the baseline with `orbitnest db diff --save`.'));
  // Non-zero exit so CI can gate on drift (like `git diff --exit-code`).
  process.exitCode = 1;
}

async function cmdDbConnect(flags: Record<string, string | boolean>) {
  const api = authed();
  const { id } = await resolveProjectId(api, str(flags, 'project'));
  let res: any;
  try {
    res = await api.get<any>(`/admin/projects/${encodeURIComponent(id)}/connection`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) {
      fail('Direct database connections are not enabled for this deployment.');
    }
    throw e;
  }
  const c = res?.data ?? res;
  heading('Direct Postgres connection');
  log(c.connection_string);
  log('');
  table(
    [
      { field: 'host', value: String(c.host) },
      { field: 'port', value: String(c.port) },
      { field: 'database', value: String(c.database) },
      { field: 'user', value: String(c.user) },
      { field: 'sslmode', value: String(c.sslmode ?? '') },
    ],
    ['field', 'value'],
  );
  if (c.pooler) {
    log(color.dim('\nPooled (transaction mode):'));
    log(c.pooler.connection_string);
  }
  if (c.warning) warn(c.warning);
}

async function cmdWebhooks(rest: string[], flags: Record<string, string | boolean>) {
  const api = authed();
  const { id } = await resolveProjectId(api, str(flags, 'project'));
  const base = `/admin/projects/${encodeURIComponent(id)}/webhooks`;
  const sub = rest[0] ?? 'list';
  if (sub === 'list') {
    const hooks = listFrom(await api.get<any>(base));
    heading(`Webhooks (${hooks.length})`);
    table(
      hooks.map((h) => ({
        id: String(h.id),
        name: String(h.name ?? ''),
        url: String(h.url ?? ''),
        events: (h.events ?? []).join('/'),
        active: h.is_active ? 'yes' : 'no',
      })),
      ['id', 'name', 'url', 'events', 'active'],
    );
  } else if (sub === 'create') {
    const url = str(flags, 'url');
    if (!url) fail('Usage: orbitnest webhooks create --url <url> [--name <n>] [--events INSERT,UPDATE,DELETE] [--table <t>]');
    const events = (str(flags, 'events') || 'INSERT,UPDATE,DELETE').split(',').map((s) => s.trim().toUpperCase());
    const res = await api.post<any>(base, { name: str(flags, 'name') || 'webhook', url, events, table_name: str(flags, 'table') || null });
    const d = res?.data ?? res;
    success(`Created webhook ${color.bold(d.id)}`);
    if (d.secret) log(`  signing secret (shown once): ${color.bold(d.secret)}`);
  } else if (sub === 'delete') {
    if (!rest[1]) fail('Usage: orbitnest webhooks delete <id>');
    await api.del(`${base}/${encodeURIComponent(rest[1])}`);
    success('Webhook deleted.');
  } else if (sub === 'test') {
    if (!rest[1]) fail('Usage: orbitnest webhooks test <id>');
    const res = await api.post<any>(`${base}/${encodeURIComponent(rest[1])}/test`);
    const d = res?.data ?? res;
    if (d.success) success(`Test delivered (HTTP ${d.status_code}).`);
    else fail(`Test failed: ${d.error || `HTTP ${d.status_code}`}`);
  } else {
    fail('Usage: orbitnest webhooks <list|create|delete|test>');
  }
}

async function cmdSms(rest: string[], flags: Record<string, string | boolean>) {
  const api = authed();
  const { id } = await resolveProjectId(api, str(flags, 'project'));
  const base = `/admin/projects/${encodeURIComponent(id)}/sms-config`;
  const sub = rest[0] ?? 'get';
  if (sub === 'get') {
    const res = await api.get<any>(base);
    const c = res?.data ?? res;
    heading('SMS / Twilio config');
    table(
      [
        { field: 'account_sid', value: String(c.account_sid ?? '—') },
        { field: 'from_number', value: String(c.from_number ?? '—') },
        { field: 'enabled', value: c.is_enabled ? 'yes' : 'no' },
        { field: 'auth_token', value: c.has_auth_token ? 'set' : 'unset' },
      ],
      ['field', 'value'],
    );
  } else if (sub === 'set') {
    const body: Record<string, unknown> = {};
    if (str(flags, 'sid') !== undefined) body.account_sid = str(flags, 'sid');
    if (str(flags, 'token') !== undefined) body.auth_token = str(flags, 'token');
    if (str(flags, 'from') !== undefined) body.from_number = str(flags, 'from');
    if (flags.enable) body.is_enabled = true;
    if (flags.disable) body.is_enabled = false;
    if (Object.keys(body).length === 0) fail('Nothing to set. Use --sid --token --from --enable/--disable.');
    await api.put(base, body);
    success('SMS config saved.');
  } else if (sub === 'test') {
    if (!rest[1]) fail('Usage: orbitnest sms test <phone>');
    await api.post(`${base}/test`, { to: rest[1] });
    success(`Test SMS sent to ${rest[1]}.`);
  } else {
    fail('Usage: orbitnest sms <get|set|test>');
  }
}

// ── help ─────────────────────────────────────────────────────────────────────
function printHelp() {
  log(`${color.bold('orbitnest')} ${color.dim('v' + VERSION)} — OrbitNest platform CLI

${color.bold('Usage')}
  orbitnest <command> [options]

${color.bold('Auth')}
  login                 Sign in (--email, --password, --code, or env / interactive)
  logout                Sign out and clear the local session
  whoami                Show the current session

${color.bold('Projects')}
  projects              List your projects
  link <id|slug>        Link the current directory to a project (.orbitnest/config.json)

${color.bold('Database & migrations')}
  migration new <name>  Scaffold a new migration file (NNN_name.sql)
  db push               Apply pending migrations
  db status             Show migration status
  db rollback [id]      Roll back the latest migration (or a specific one)
  db reset --yes        Drop all tables and re-apply every migration (destructive)
  db sql "<SQL>"        Run SQL against the linked project (--file <path>)
  db connect            Show the direct Postgres connection string (if enabled)
  db diff               Show schema drift vs the saved snapshot (--save to update it)
  gen types             Generate TypeScript types from the schema (--out, --stdout)

${color.bold('Integrations')}
  webhooks list                         List webhooks
  webhooks create --url <u> [--events] [--table] [--name]
  webhooks delete <id> | test <id>      Remove / send a test event
  sms get                               Show the project's Twilio config
  sms set [--sid][--token][--from][--enable|--disable]
  sms test <phone>                      Send a test SMS

${color.bold('Options')}
  -p, --project <id>    Target project (overrides the linked one)
  -d, --dir <path>      Migrations directory (default: migrations)
  -o, --out <file>      Output file for gen types
      --url <url>       API base URL for login (default: https://api.orbitnest.io)
      --code <code>     Two-factor code for login (or env ORBITNEST_MFA_CODE)
  -h, --help            Show help
  -v, --version         Show version

${color.dim('Migrations run DDL via the admin SQL endpoint. Files may include a')}
${color.dim('`-- migrate:down` section for rollback.')}`);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.version) { log(VERSION); return; }
  const cmd = positionals[0];
  if (!cmd || flags.help || cmd === 'help') { printHelp(); return; }

  const rest = positionals.slice(1);
  switch (cmd) {
    case 'login': return cmdLogin(flags);
    case 'logout': return cmdLogout();
    case 'whoami': return cmdWhoami();
    case 'projects': return cmdProjects();
    case 'link': return cmdLink(rest);
    case 'migration':
      if (rest[0] === 'new') return cmdMigrationNew(rest.slice(1), flags);
      return fail('Usage: orbitnest migration new <name>');
    case 'db':
      switch (rest[0]) {
        case 'push': return cmdDbPush(flags);
        case 'status': return cmdDbStatus(flags);
        case 'rollback': return cmdDbRollback(rest.slice(1), flags);
        case 'reset': return cmdDbReset(flags);
        case 'sql': return cmdDbSql(rest.slice(1), flags);
        case 'connect': return cmdDbConnect(flags);
        case 'diff': return cmdDbDiff(flags);
        default: return fail('Usage: orbitnest db <push|status|rollback|reset|sql|connect|diff>');
      }
    case 'webhooks': return cmdWebhooks(rest, flags);
    case 'sms': return cmdSms(rest, flags);
    case 'gen':
      if (rest[0] === 'types') return cmdGenTypes(flags);
      return fail('Usage: orbitnest gen types');
    default:
      fail(`Unknown command "${cmd}". Run \`orbitnest --help\`.`);
  }
}

main().catch((e) => {
  // Set the exit code and let the event loop drain naturally — a hard
  // process.exit() races with closing libuv handles and asserts on Windows.
  if (e instanceof ExitSignal) {
    process.exitCode = e.code; // message was already printed by fail()
  } else if (e instanceof ApiError && e.status === 401) {
    console.error(`${color.red('✗')} Unauthorized — your session may have expired. Run \`orbitnest login\`.`);
    process.exitCode = 1;
  } else {
    console.error(`${color.red('✗')} ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
});
