# Coolify deployment

This directory documents how to deploy the project on [Coolify](https://coolify.io).
The topology mirrors what `docker-compose.yml` describes, but each service runs
as its own Coolify "Application" so env vars, restarts and resource limits stay
isolated.

## Topology

| Coolify app    | Source build       | Start command                                    | Public  | Persistent volume |
|----------------|--------------------|--------------------------------------------------|---------|-------------------|
| `bot-15m`      | `./Dockerfile`     | `node --max-old-space-size=384 src/index.js`     | no      | `logs` (`/app/logs`) |
| `bot-5m`       | `./Dockerfile`     | `node --max-old-space-size=384 src/index5m.js`   | no      | `logs` (`/app/logs`) |
| `dashboard`    | `./Dockerfile.dashboard` | (image default `node src/logServer.js`)    | yes (port 3456) | `logs` (`/app/logs`) |
| `postgres`     | Coolify "Database" service (Postgres 16) | n/a                | no      | managed by Coolify   |

The `logs` volume MUST be the same physical storage mounted by all three app
containers — that is how the dashboard reads the bots' CSVs. In Coolify this is
done with a "Shared Persistent Storage" entry attached to each of the three
app definitions, mounted at `/app/logs`.

Postgres is only consumed by `dashboard` (better-auth sessions). The bots
do not depend on it.

## One-time setup (per environment)

1. **Create the Postgres database.** In Coolify → *Databases* → New → Postgres 16.
   Save the connection string; you will paste it into `dashboard`'s env as
   `DATABASE_URL`.
2. **Create the shared persistent volume.** In the project → *Storages* → New
   "Shared volume" called `polymarket-logs`. Mount path `/app/logs`.
3. **Create three Applications**, all pointing at the same Git repo:
    - `bot-15m`  → Dockerfile `Dockerfile`, start command `node --max-old-space-size=384 src/index.js`
    - `bot-5m`   → Dockerfile `Dockerfile`, start command `node --max-old-space-size=384 src/index5m.js`
    - `dashboard`→ Dockerfile `Dockerfile.dashboard`, leave start command empty (use image default)

   In each application:
    - Attach the `polymarket-logs` shared volume at `/app/logs`.
    - Set the branch (see *Environments* below).
    - Paste the env vars listed below.

4. **Expose the dashboard.** On the `dashboard` app, set the published port to
   `3456` and attach a domain. Bots stay internal — never expose them.

5. **First boot.** The dashboard container runs Drizzle migrations and the
   admin seed automatically before listening. Watch the logs to confirm
   `DB migrations applied` and `Admin seed: { created: true, ... }` appear.

## Required env vars per application

### `bot-15m` and `bot-5m`

Both bots accept the full set in `.env.example`. The minimum to enable real
trading:

```
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER=0x...
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_TRADE_AMOUNT=5
DRY_RUN=false
```

To run paper-trading-only on either bot, set `DRY_RUN=true` (the simulator and
CSV logging still work).

### `dashboard`

```
DATABASE_URL=postgres://<user>:<password>@<host>:5432/<db>     # from Coolify Postgres
BETTER_AUTH_SECRET=<openssl rand -base64 48>
BETTER_AUTH_URL=https://dashboard.example.com                  # the public URL Coolify exposes
AUTH_TRUSTED_ORIGINS=https://dashboard.example.com
DASHBOARD_ADMIN_EMAIL=you@example.com
DASHBOARD_ADMIN_PASSWORD=<minimum 12 chars>
DASHBOARD_ADMIN_NAME=Admin
```

To rotate the admin password without manual SQL: set
`DASHBOARD_ADMIN_RESET_PASSWORD=true`, change `DASHBOARD_ADMIN_PASSWORD`,
redeploy the dashboard, then flip the reset flag back to `false`.

## Environments (prod vs staging)

Use **two Coolify projects** so env vars, secrets, volumes and Postgres
instances are physically isolated.

| Project   | Git branch | DRY_RUN  | Trading key | Logs volume |
|-----------|------------|----------|-------------|-------------|
| `prod`    | `main`     | `false`  | real        | `polymarket-logs-prod` |
| `staging` | `staging`  | `true`   | unset       | `polymarket-logs-staging` |

Each project gets its own Postgres database. Never share an admin user across
environments — staging gets its own `DASHBOARD_ADMIN_*` values.

### Staging branch flow

```
git switch staging
git merge main           # pull production into staging
# tweak TRADE_* env vars in Coolify staging project to test
git push origin staging  # Coolify auto-deploys
```

When a staging tweak proves out, port the change back to `main`:

```
git switch main
# update env defaults / config5m.js as needed
git push origin main     # Coolify prod project auto-deploys
```

## Operational notes

- Restarting a single service (e.g. only `bot-5m`) is a one-button action in
  Coolify — the others keep running.
- Redeploying `dashboard` re-runs migrations idempotently; the admin seed
  skips if the user already exists (unless `DASHBOARD_ADMIN_RESET_PASSWORD=true`).
- The dashboard's `POST /api/logs/clear` endpoint truncates CSVs that the bots
  are actively writing to. It is now gated by login but still has destructive
  effects — use with care, especially in `prod`.
- `GET /api/health` is the only unauthenticated endpoint. Use it as Coolify's
  health check URL for the dashboard.
