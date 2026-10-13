import { homedir } from 'os';
import { join, resolve } from 'path';
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, openSync, closeSync, unlinkSync, statSync } from 'fs';
import { fail } from './ui';

const DEFAULT_API = 'https://api.orbitnest.io';

// Global credentials (shared with the OrbitNest MCP server) — 0600.
const CRED_DIR = join(homedir(), '.orbitnest');
const CRED_FILE = join(CRED_DIR, 'credentials.json');
// Advisory lock shared with the MCP server — serialises refresh-token rotation
// across processes (the API revokes every session when a consumed token is replayed).
const CRED_LOCK = join(CRED_DIR, 'credentials.lock');

// Per-directory project link — safe to commit.
const LINK_DIR = resolve('.orbitnest');
const LINK_FILE = join(LINK_DIR, 'config.json');

export interface Credentials {
  apiUrl?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  user?: { id?: string; email?: string; full_name?: string };
}

/**
 * `.orbitnest/config.json`, shared with the MCP server. Canonical shape is
 * `{ projectId, projectSlug, name?, apiUrl? }`; CLI <= 0.5 wrote `slug`, so
 * readers accept either.
 */
export interface ProjectLink {
  projectId: string;
  projectSlug?: string;
  name?: string;
  apiUrl?: string;
}

export function loadCredentials(): Credentials {
  try {
    return JSON.parse(readFileSync(CRED_FILE, 'utf8')) as Credentials;
  } catch {
    return {};
  }
}

/** Atomic write (temp file + rename) so a concurrent reader never sees a partial file. */
export function saveCredentials(c: Credentials): void {
  mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(c, null, 2);
  const tmp = `${CRED_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  try {
    renameSync(tmp, CRED_FILE);
  } catch {
    // Windows can refuse the rename while another process has the file open.
    writeFileSync(CRED_FILE, body, { mode: 0o600 });
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
  // `mode` only applies on creation — tighten a pre-existing wider file too.
  try { chmodSync(CRED_FILE, 0o600); } catch { /* no-op on Windows */ }
}

/** Run `fn` while holding the cross-process credentials lock (shared with the MCP server). */
export async function withCredentialsLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 90_000;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(CRED_LOCK, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // A holder that crashed leaves the lock behind; a refresh never takes 75s.
      try { if (Date.now() - statSync(CRED_LOCK).mtimeMs > 75_000) unlinkSync(CRED_LOCK); } catch { /* raced */ }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${CRED_LOCK}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(CRED_LOCK); } catch { /* ignore */ }
  }
}

export function loadLink(): ProjectLink | null {
  try {
    const raw = JSON.parse(readFileSync(LINK_FILE, 'utf8'));
    if (!raw?.projectId) return null;
    return { projectId: raw.projectId, projectSlug: raw.projectSlug ?? raw.slug, name: raw.name, apiUrl: raw.apiUrl };
  } catch {
    return null;
  }
}

export function saveLink(link: ProjectLink): void {
  try {
    mkdirSync(LINK_DIR, { recursive: true });
    writeFileSync(LINK_FILE, JSON.stringify(link, null, 2));
  } catch (e) {
    fail(`Could not write ${LINK_FILE}: ${(e as Error).message}`);
  }
}

const stripSlash = (u: string) => u.replace(/\/+$/, '');

/** Resolve the API base URL: env → linked project → credentials → default. */
export function apiUrl(): string {
  return stripSlash(
    process.env.ORBITNEST_API_URL ||
      loadLink()?.apiUrl ||
      loadCredentials().apiUrl ||
      DEFAULT_API,
  );
}

/** Decode a JWT's `exp` (seconds) → ISO string, best-effort. */
export function jwtExpiry(token: string): string | undefined {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return json.exp ? new Date(json.exp * 1000).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

/** Minimal fetch-based client for the OrbitNest admin API (`${apiUrl}/api`). */
export class Api {
  private readonly base: string;

  constructor(
    base: string,
    private token?: string,
    private readonly refresher?: (staleToken?: string) => Promise<string | null>,
  ) {
    this.base = stripSlash(base);
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { noAuth?: boolean; query?: Record<string, string | undefined>; retried?: boolean } = {},
  ): Promise<T> {
    let url = `${this.base}/api${path}`;
    if (opts.query) {
      const pairs = Object.entries(opts.query).filter(([, v]) => v != null && v !== '') as [string, string][];
      const qs = new URLSearchParams(pairs).toString();
      if (qs) url += `?${qs}`;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!opts.noAuth && this.token) headers.Authorization = `Bearer ${this.token}`;

    // Manual timeout so we can clear it — a dangling timer left by
    // AbortSignal.timeout crashes libuv when the process exits on Windows.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    timer.unref?.();

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      throw new ApiError(`Network error calling ${method} ${path}: ${(e as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text };
    }
    if (!res.ok) {
      // Transparently refresh an expired access token once, then retry.
      if (res.status === 401 && !opts.noAuth && this.refresher && !opts.retried) {
        const fresh = await this.refresher(this.token);
        if (fresh) {
          this.token = fresh;
          return this.req<T>(method, path, body, { ...opts, retried: true });
        }
      }
      let msg = json?.message || json?.error || res.statusText;
      if (Array.isArray(msg)) msg = msg.join('; ');
      if (res.status === 403 && /restricted to the project owner/i.test(String(msg))) {
        msg +=
          '. Raw SQL (incl. migrations, db reset, gen types, db diff), dropping tables, RLS toggles and policy ' +
          'changes are limited to the user who created the project. Ask the project owner to run this.';
      }
      throw new ApiError(msg, res.status);
    }
    return json as T;
  }

  get<T>(path: string, query?: Record<string, string | undefined>) {
    return this.req<T>('GET', path, undefined, { query });
  }
  post<T>(path: string, body?: unknown, opts?: { noAuth?: boolean }) {
    return this.req<T>('POST', path, body, opts);
  }
  put<T>(path: string, body?: unknown) {
    return this.req<T>('PUT', path, body);
  }
  del<T>(path: string) {
    return this.req<T>('DELETE', path);
  }
}

/** An API client authenticated with the stored token, or exit with guidance. */
export function authed(): Api {
  const creds = loadCredentials();
  if (!creds.access_token) fail('Not logged in. Run `orbitnest login` first.');
  return new Api(apiUrl(), creds.access_token, refreshAccessToken);
}

/**
 * Exchange the stored refresh token for a fresh access token and persist it.
 * Returns the new access token, or null if there's nothing to refresh with or
 * the refresh was rejected (the caller then surfaces the original 401).
 *
 * The API rotates refresh tokens and revokes ALL of the admin's sessions when a
 * consumed one is replayed. So this runs under the shared lock and re-reads the
 * file first: if another process (the MCP server, another CLI run) already
 * rotated, its fresh access token is used instead of refreshing again.
 */
async function refreshAccessToken(staleToken?: string): Promise<string | null> {
  try {
    return await withCredentialsLock(async () => {
      const creds = loadCredentials();
      if (creds.access_token && creds.access_token !== staleToken) return creds.access_token;
      if (!creds.refresh_token) return null;
      const res = await new Api(apiUrl()).post<any>(
        '/auth/refresh',
        { refresh_token: creds.refresh_token },
        { noAuth: true },
      );
      const access = res.access_token ?? res.data?.access_token;
      const refresh = res.refresh_token ?? res.data?.refresh_token ?? creds.refresh_token;
      if (!access) return null;
      saveCredentials({ ...creds, access_token: access, refresh_token: refresh, expires_at: jwtExpiry(access) });
      return access;
    });
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Find a project by id or slug, falling back to a case-insensitive name. A name
 * shared by several projects is refused, so `db push` / `db reset` never target
 * an arbitrary one of them.
 */
export function matchProject(projects: any[], ref: string): any {
  const exact = projects.find((p) => p.id === ref || p.slug === ref);
  if (exact) return exact;
  const byName = projects.filter((p) => String(p.name).toLowerCase() === ref.toLowerCase());
  if (byName.length > 1) {
    fail(`"${ref}" matches ${byName.length} projects (${byName.map((p) => p.slug).join(', ')}). Use the slug or id instead.`);
  }
  if (!byName[0]) fail(`No project matching "${ref}". Run \`orbitnest projects\` to see them.`);
  return byName[0];
}

/**
 * Resolve the active project id: `--project` flag → linked project → error.
 * A flag value may be a UUID (used as-is) or a slug/name (resolved to its id
 * via the projects list — the SQL endpoint requires a UUID).
 */
export async function resolveProjectId(
  api: Api,
  flagProject?: string,
): Promise<{ id: string; slug?: string }> {
  if (flagProject) {
    if (UUID_RE.test(flagProject)) return { id: flagProject };
    const res = await api.get<any>('/projects');
    const projects: any[] = Array.isArray(res) ? res : (res?.data ?? res?.projects ?? []);
    const match = matchProject(projects, flagProject);
    return { id: match.id, slug: match.slug };
  }
  const link = loadLink();
  if (link) return { id: link.projectId, slug: link.projectSlug };
  fail('No project selected. Run `orbitnest link <project>` or pass `--project <id|slug>`.');
}
