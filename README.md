# @nestcorehq/cli

The command-line interface for the [NestCore](https://nestcore.io) platform.

`nestcore` brings the day-to-day backend workflow into your terminal and your
repo: sign in once, link a directory to a project, run versioned SQL
migrations, and generate TypeScript types straight from your live schema — the
same ergonomics you expect from a modern backend toolchain.

```bash
npm install -g @nestcorehq/cli
# or run without installing:
npx @nestcorehq/cli --help
```

> Requires Node.js 22+.

---

## Quick start

```bash
# 1. Sign in (credentials are stored in ~/.nestcore/credentials.json, mode 0600)
nestcore login

# 2. Link the current directory to one of your projects
nestcore link my-project        # by slug, name, or id
#   → writes .nestcore/config.json (safe to commit)

# 3. Scaffold and apply a migration
nestcore migration new "create posts table"
#   → edits migrations/001_create_posts_table.sql
nestcore db push

# 4. Generate types from the live schema
nestcore gen types              # → nestcore.types.ts
```

---

## Commands

### Auth

| Command | Description |
| --- | --- |
| `nestcore login` | Sign in. Reads `--email` / `--password`, then `NESTCORE_EMAIL` / `NESTCORE_PASSWORD`, then prompts interactively (password input is masked). |
| `nestcore logout` | Revoke the refresh token and clear the local session. |
| `nestcore whoami` | Show the current session, API URL, and token expiry. |

### Projects

| Command | Description |
| --- | --- |
| `nestcore projects` | List your projects (name, slug, id). |
| `nestcore link [id\|slug\|name]` | Link the current directory to a project. With no argument and a single project, links it automatically; otherwise lists choices. Writes `.nestcore/config.json`. Add `--branch development` to make Development the default for this directory. |

### Branches

Every App project has a **Production** branch (the live project) and a **Development** branch: a copy of Production's schema and config (tables, RLS, functions, buckets, auth settings) with its own data, end users, URL and keys. Schema changes you make on Development are recorded and can be promoted to Production.

| Command | Description |
| --- | --- |
| `nestcore branches` | Production and Development: status, database and file sizes, changes waiting to be promoted. |
| `nestcore branches create` | Create the Development branch (schema + config, no data). |
| `nestcore branches reset --yes` | Rebuild Development from Production. Deletes its rows, end users and files; keeps its URL, keys, env vars and functions. |
| `nestcore branches changes` | Schema changes recorded on Development and not promoted yet (`!` = can lose data). |
| `nestcore branches discard <id…>` | Drop recorded changes so they are never promoted. |
| `nestcore branches promote` | Preview what would be promoted. |
| `nestcore branches promote --yes` | Promote (workspace admins). Schema changes run in one transaction on Production; then functions, new buckets and new jobs (created off). Add `--env` for missing env vars, `--auth-settings` to copy auth settings, `--confirm-destructive` for DROP / RENAME / type changes, `--acknowledge-drift` if Production changed meanwhile. |
| `nestcore branches delete --yes` | Delete the Development branch (workspace admins). |

Target a branch on any command with `--branch production` or `--branch development` (`-b`, also `prod` / `dev`), or link the directory with `--branch`. A typical flow:

```bash
nestcore link my-app --branch development
nestcore db push                 # migrations go to Development
nestcore gen types
nestcore branches promote        # review
nestcore branches promote --yes  # apply to Production
```

### Database & migrations

| Command | Description |
| --- | --- |
| `nestcore migration new <name>` | Scaffold `migrations/NNN_<name>.sql` with `up` / `-- migrate:down` sections. |
| `nestcore db push` | Apply every pending migration in order, inside a transaction each. |
| `nestcore db status` | Show which migrations are applied, pending, failed, or modified-after-apply. |
| `nestcore db rollback [id]` | Roll back the latest applied migration (or a specific `id`) using its `-- migrate:down` section. |
| `nestcore db reset --yes` | **Destructive.** Drop every table in the project (internal `auth_*` tables are spared) and re-apply all migrations from scratch. Requires `--yes`. First dry-runs the drop + every migration in a rolled-back transaction; if that fails, nothing is dropped. |
| `nestcore db sql "<SQL>"` | Run ad-hoc SQL against the linked project. `--file <path>` runs a file. |
| `nestcore db connect` | Print the direct Postgres connection string (when the deployment has direct connections enabled). |
| `nestcore gen types` | Introspect the schema and emit TypeScript interfaces + a `Database` map (`bigint`/`numeric` and enums are typed `string`, `json`/`jsonb` `unknown` — matching what the API returns). `--out <file>` (default `nestcore.types.ts`) or `--stdout`. |

### Integrations

| Command | Description |
| --- | --- |
| `nestcore webhooks list` | List the project's webhooks. |
| `nestcore webhooks create --url <u> [--events INSERT,UPDATE,DELETE] [--table <t>] [--name <n>]` | Create a webhook (prints the signing secret once). |
| `nestcore webhooks delete <id>` / `test <id>` | Remove a webhook / send it a test event. |
| `nestcore sms get` | Show the project's Twilio/SMS config. |
| `nestcore sms set [--sid <s>] [--token <t>] [--from <n>] [--enable\|--disable]` | Configure Twilio (auth token stored encrypted). |
| `nestcore sms test <phone>` | Send a test SMS. |

### AI

| Command | Description |
| --- | --- |
| `nestcore ai overview` | Counts of memories, memory subjects, collections, documents, threads, messages, traces (last 24 h) and embedded columns. Shows zeros until the project uses an AI feature. |
| `nestcore ai embeddings list` | Embedded columns with progress: rows, embedded, pending, failed and the last error. |
| `nestcore ai embeddings enable --table <t> --columns <a,b> [--target <col>] [--model <m>] [--provider <p>]` | Keep a `vector(768)` column (default `<first column>_embedding`) up to date from the source columns, and backfill existing rows. Admin role. |
| `nestcore ai embeddings reembed <table> <column> [--model <m>] [--provider <p>]` | Re-embed every row, optionally switching model. Admin role. |
| `nestcore ai embeddings disable <table> <column> [--drop-columns]` | Stop embedding a column; `--drop-columns` also drops the vector columns. Admin role. |
| `nestcore ai collections list` | Vector collections with their model, document counts and chunking. |
| `nestcore ai traces [--limit n] [--status ok\|error]` | Recent AI calls (default 20, max 500): kind, caller, model, tokens, cost, latency and status. |

### AI credit

Prepaid AI credit belongs to the workspace and is shared by all its projects. It pays for AI calls of projects
without their own provider key (a project's own key always wins), at the platform's key plus the margin. A
workspace that never bought credit is never charged.

| Command | Description |
| --- | --- |
| `nestcore credits` | Balance, monthly cap, this month's spend, whether credit can pay for a call now, the credit packs and the recent ledger. |
| `nestcore credits buy <pack> [--open]` | Print a Stripe Checkout link for a pack (e.g. `credits_10`) to open and pay in the browser; `--open` opens it. Nothing is charged until you pay, and the credit appears once Stripe confirms. Admin role. |
| `nestcore credits cap <usd\|off>` | Set the monthly cap on credit spend (e.g. `20` or `12.50`), or remove it with `off`. Admin role. |

An AI call paid from credit fails with `CREDITS_EXHAUSTED` when the balance is gone or the cap is reached; the CLI
prints which one, the next step and the buy link.

### Options

| Option | Applies to | Description |
| --- | --- | --- |
| `-p, --project <id\|slug>` | db / gen / webhooks / sms / auth-security / ai / branches | Target a specific project, overriding the linked one. |
| `-b, --branch <name>` | db / gen / webhooks / sms / auth-security / ai | `production` or `development` (`prod` / `dev`), overriding the linked branch. |
| `-d, --dir <path>` | migration / db | Migrations directory (default `migrations`). |
| `-o, --out <file>` | gen types | Output file. |
| `--stdout` | gen types | Print to stdout instead of a file. |
| `-f, --file <path>` | db sql | Read SQL from a file. |
| `--url <url>` | login | API base URL (default `https://api.nestcore.io`). |
| `-h, --help` | — | Show help. |
| `-v, --version` | — | Show version. |

---

## Migrations

A migration is a plain `.sql` file named `NNN_description.sql`. The numeric
prefix defines apply order. An optional `-- migrate:down` line splits the file
into a forward (`up`) section and a rollback (`down`) section:

```sql
-- Migration 001: create posts table
-- Forward (up) SQL — applied by `nestcore db push`.
CREATE TABLE posts (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- migrate:down
-- Rollback SQL — applied by `nestcore db rollback`.
DROP TABLE posts;
```

How it works:

- A `migrations` registry table tracks `migration_id`, `name`, `checksum`,
  `executed_at`, and `status`.
- Each migration runs wrapped in `BEGIN; … COMMIT;` — a failure rolls the whole
  file back and is recorded as `failed`.
- Already-applied migrations are skipped. If an applied file's checksum no
  longer matches, `db push` refuses to continue (add a new migration instead of
  editing history).

---

## Type generation

`nestcore gen types` reads `information_schema.columns` for your `public`
schema (skipping internal `auth_*`, `pg_*`, and `_*` tables) and emits a
strongly-typed module:

```ts
// Generated by @nestcorehq/cli — do not edit by hand.
export interface Posts {
  id: string;
  title: string;
  created_at?: string | null;
}

export interface Database {
  "posts": Posts;
}
```

Re-run it after every schema change and commit the output, or wire it into a
`predev` / `prebuild` script.

---

## Permissions

Raw SQL (`db sql`, `db push`/`status`/`rollback`/`reset`, `gen types`, `db diff`) runs only for the user who **created** the project; other workspace members get a 403 explaining this.

## Configuration & files

| Path | Scope | Contents |
| --- | --- | --- |
| `~/.nestcore/credentials.json` | global, `0600` | Access/refresh tokens, API URL, user. Shared with the NestCore MCP server; token refreshes are serialised through `~/.nestcore/credentials.lock`. |
| `./.nestcore/config.json` | per-directory | Linked `projectId`, `projectSlug`, `name`, `apiUrl` and optional `branch` (same file the MCP server reads; older files with `slug` still work). Safe to commit. |

Environment variables (override stored values):

- `NESTCORE_API_URL` — API base URL.
- `NESTCORE_EMAIL`, `NESTCORE_PASSWORD` — non-interactive login.
- `NESTCORE_MFA_CODE` — two-factor code for non-interactive login.
- `NO_COLOR` — disable ANSI colors.

### Upgrading from `@orbitneststudio/cli`

The CLI was renamed from OrbitNest to NestCore. Existing setups keep working:

- `orbitnest` is installed as a second command name for `nestcore`.
- `~/.orbitnest/credentials.json` is read when `~/.nestcore/credentials.json`
  doesn't exist yet; new sessions are written to `~/.nestcore` (and mirrored to
  the old file while it exists, so older tools sharing it stay signed in).
- `./.orbitnest/config.json` and `./.orbitnest/schema.snapshot.json` are read
  when the `.nestcore` equivalents are absent; `link` and `db diff --save` write
  the new paths.
- The old `ORBITNEST_*` environment variables are used when the `NESTCORE_*`
  ones are unset.

---

## Development

```bash
npm install
npm run build      # bundle to dist/ with tsup (CJS + shebang)
npm run dev        # watch mode
npm run typecheck  # tsc --noEmit
npm test           # build, then run test/*.mjs against a local fake API

node dist/index.js --help
```

---

## License

MIT © NestCore
