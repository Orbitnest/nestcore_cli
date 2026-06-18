import { homedir } from 'os';
import { join, resolve } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fail } from './ui';

const DEFAULT_API = 'https://api.orbitnest.io';

// Global credentials (shared with the OrbitNest MCP server) — 0600.
const CRED_DIR = join(homedir(), '.orbitnest');
const CRED_FILE = join(CRED_DIR, 'credentials.json');

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

export interface ProjectLink {
  projectId: string;
  slug: string;
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

export function saveCredentials(c: Credentials): void {
  mkdirSync(CRED_DIR, { recursive: true });
  writeFileSync(CRED_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function loadLink(): ProjectLink | null {
  try {
    return JSON.parse(readFileSync(LINK_FILE, 'utf8')) as ProjectLink;
  } catch {
    return null;
  }
}

export function saveLink(link: ProjectLink): void {
  mkdirSync(LINK_DIR, { recursive: true });
  writeFileSync(LINK_FILE, JSON.stringify(link, null, 2));
}

/** Resolve the API base URL: env → linked project → credentials → default. */
export function apiUrl(): string {
  return (
    process.env.ORBITNEST_API_URL ||
    loadLink()?.apiUrl ||
    loadCredentials().apiUrl ||
    DEFAULT_API
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
  constructor(
    private readonly base: string,
    private token?: string,
    private readonly refresher?: () => Promise<string | null>,
  ) {}

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
        const fresh = await this.refresher();
        if (fresh) {
          this.token = fresh;
          return this.req<T>(method, path, body, { ...opts, retried: true });
        }
      }
      throw new ApiError(json?.message || json?.error || res.statusText, res.status);
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
 */
async function refreshAccessToken(): Promise<string | null> {
  const creds = loadCredentials();
  if (!creds.refresh_token) return null;
  try {
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
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const match =
      projects.find((p) => p.id === flagProject || p.slug === flagProject) ??
      projects.find((p) => String(p.name).toLowerCase() === flagProject.toLowerCase());
    if (!match) fail(`No project matching "${flagProject}". Run \`orbitnest projects\` to see them.`);
    return { id: match.id, slug: match.slug };
  }
  const link = loadLink();
  if (link) return { id: link.projectId, slug: link.slug };
  fail('No project selected. Run `orbitnest link <project>` or pass `--project <id|slug>`.');
}
