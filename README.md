# @orbitneststudio/cli

The command-line interface for the [OrbitNest](https://orbitnest.io) platform.

`orbitnest` brings the day-to-day backend workflow into your terminal and your
repo: sign in once, link a directory to a project, run versioned SQL
migrations, and generate TypeScript types straight from your live schema — the
same ergonomics you expect from a modern backend toolchain.

```bash
npm install -g @orbitneststudio/cli
# or run without installing:
npx @orbitneststudio/cli --help
```

> Requires Node.js 18+.

---

## Quick start

```bash
# 1. Sign in (credentials are stored in ~/.orbitnest/credentials.json, mode 0600)
orbitnest login

# 2. Link the current directory to one of your projects
orbitnest link my-project        # by slug, name, or id
#   → writes .orbitnest/config.json (safe to commit)

# 3. Scaffold and apply a migration
orbitnest migration new "create posts table"
#   → edits migrations/001_create_posts_table.sql
orbitnest db push

# 4. Generate types from the live schema
orbitnest gen types              # → orbitnest.types.ts
```

---

## Commands

### Auth

| Command | Description |
| --- | --- |
| `orbitnest login` | Sign in. Reads `--email` / `--password`, then `ORBITNEST_EMAIL` / `ORBITNEST_PASSWORD`, then prompts interactively (password input is masked). |
| `orbitnest logout` | Revoke the refresh token and clear the local session. |
| `orbitnest whoami` | Show the current session, API URL, and token expiry. |

### Projects

| Command | Description |
| --- | --- |
| `orbitnest projects` | List your projects (name, slug, id). |
| `orbitnest link [id\|slug\|name]` | Link the current directory to a project. With no argument and a single project, links it automatically; otherwise lists choices. Writes `.orbitnest/config.json`. |

### Database & migrations

| Command | Description |
| --- | --- |
| `orbitnest migration new <name>` | Scaffold `migrations/NNN_<name>.sql` with `up` / `-- migrate:down` sections. |
| `orbitnest db push` | Apply every pending migration in order, inside a transaction each. |
| `orbitnest db status` | Show which migrations are applied, pending, failed, or modified-after-apply. |
| `orbitnest db rollback [id]` | Roll back the latest applied migration (or a specific `id`) using its `-- migrate:down` section. |
| `orbitnest db reset --yes` | **Destructive.** Drop every table in the project (internal `auth_*` tables are spared) and re-apply all migrations from scratch. Requires `--yes`. First dry-runs the drop + every migration in a rolled-back transaction; if that fails, nothing is dropped. |
| `orbitnest db sql "<SQL>"` | Run ad-hoc SQL against the linked project. `--file <path>` runs a file. |
| `orbitnest db connect` | Print the direct Postgres connection string (when the deployment has direct connections enabled). |
| `orbitnest gen types` | Introspect the schema and emit TypeScript interfaces + a `Database` map (`bigint`/`numeric` and enums are typed `string`, `json`/`jsonb` `unknown` — matching what the API returns). `--out <file>` (default `orbitnest.types.ts`) or `--stdout`. |

### Integrations

| Command | Description |
| --- | --- |
| `orbitnest webhooks list` | List the project's webhooks. |
| `orbitnest webhooks create --url <u> [--events INSERT,UPDATE,DELETE] [--table <t>] [--name <n>]` | Create a webhook (prints the signing secret once). |
| `orbitnest webhooks delete <id>` / `test <id>` | Remove a webhook / send it a test event. |
| `orbitnest sms get` | Show the project's Twilio/SMS config. |
| `orbitnest sms set [--sid <s>] [--token <t>] [--from <n>] [--enable\|--disable]` | Configure Twilio (auth token stored encrypted). |
| `orbitnest sms test <phone>` | Send a test SMS. |

### Options

| Option | Applies to | Description |
| --- | --- | --- |
| `-p, --project <id\|slug>` | db / gen | Target a specific project, overriding the linked one. |
| `-d, --dir <path>` | migration / db | Migrations directory (default `migrations`). |
| `-o, --out <file>` | gen types | Output file. |
| `--stdout` | gen types | Print to stdout instead of a file. |
| `-f, --file <path>` | db sql | Read SQL from a file. |
| `--url <url>` | login | API base URL (default `https://api.orbitnest.io`). |
| `-h, --help` | — | Show help. |
| `-v, --version` | — | Show version. |

---

## Migrations

A migration is a plain `.sql` file named `NNN_description.sql`. The numeric
prefix defines apply order. An optional `-- migrate:down` line splits the file
into a forward (`up`) section and a rollback (`down`) section:

```sql
-- Migration 001: create posts table
-- Forward (up) SQL — applied by `orbitnest db push`.
CREATE TABLE posts (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- migrate:down
-- Rollback SQL — applied by `orbitnest db rollback`.
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

`orbitnest gen types` reads `information_schema.columns` for your `public`
schema (skipping internal `auth_*`, `pg_*`, and `_*` tables) and emits a
strongly-typed module:

```ts
// Generated by @orbitneststudio/cli — do not edit by hand.
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
| `~/.orbitnest/credentials.json` | global, `0600` | Access/refresh tokens, API URL, user. Shared with the OrbitNest MCP server; token refreshes are serialised through `~/.orbitnest/credentials.lock`. |
| `./.orbitnest/config.json` | per-directory | Linked `projectId`, `projectSlug`, `name`, `apiUrl` (same file the MCP server reads; older files with `slug` still work). Safe to commit. |

Environment variables (override stored values):

- `ORBITNEST_API_URL` — API base URL.
- `ORBITNEST_EMAIL`, `ORBITNEST_PASSWORD` — non-interactive login.
- `NO_COLOR` — disable ANSI colors.

---

## Development

```bash
npm install
npm run build      # bundle to dist/ with tsup (CJS + shebang)
npm run dev        # watch mode
npm run typecheck  # tsc --noEmit

node dist/index.js --help
```

---

## License

MIT © OrbitNest
