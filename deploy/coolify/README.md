# Coolify deployment

This directory documents how to deploy the project on [Coolify](https://coolify.io).
The topology mirrors what `docker-compose.yml` describes, but each service runs
as its own Coolify "Application" so env vars, restarts and resource limits stay
isolated.

## Topology

| Coolify app    | Source build             | Selector (env)   | Public          | Persistent volume    |
|----------------|--------------------------|------------------|-----------------|----------------------|
| `bot-15m`      | `./Dockerfile`           | `BOT_MODE=15m`   | no              | `logs` (`/app/logs`) |
| `bot-5m`       | `./Dockerfile`           | `BOT_MODE=5m`    | no              | `logs` (`/app/logs`) |
| `dashboard`    | `./Dockerfile.dashboard` | n/a              | yes (port 3456) | `logs` (`/app/logs`) |

Both bots share the same `Dockerfile`. The entrypoint reads the `BOT_MODE`
env var to decide which script to run (`src/index.js` for 15m,
`src/index5m.js` for 5m). This sidesteps Coolify's lack of a per-app start
command override for Dockerfile build packs — the start command lives in the
image, the env var selects the bot.

The `logs` volume MUST be the same physical storage mounted by all three app
containers — that is how the dashboard reads the bots' CSVs. In Coolify this is
done with a "Shared Persistent Storage" entry attached to each of the three
app definitions, mounted at `/app/logs`.

Auth state (better-auth users + sessions) lives in a SQLite file inside the
same `logs` volume (`/app/logs/auth.db`). No separate database service is
needed. The bots do not read or write the auth DB.

## One-time setup (per environment)

1. **Create the shared persistent volume.** In the project → *Storages* → New
   "Shared volume" called `polymarket-logs`. Mount path `/app/logs`.
2. **Create the Applications**, all pointing at the same Git repo:
    - `bot-15m`  → Dockerfile `Dockerfile`, env `BOT_MODE=15m`
    - `bot-5m`   → Dockerfile `Dockerfile`, env `BOT_MODE=5m`
    - `dashboard`→ Dockerfile `Dockerfile.dashboard`

   In each application:
    - Attach the `polymarket-logs` shared volume at `/app/logs`.
    - Set the branch (see *Environments* below).
    - Paste the env vars listed below.

   Coolify's Application + Dockerfile build pack has **no Start Command field**;
   `Custom Docker Options` only accepts `docker run` flags. The bot script is
   chosen entirely by the `BOT_MODE` env var. To run a different bot, change
   the env var and redeploy — no Dockerfile edit needed.

3. **Expose the dashboard.** On the `dashboard` app, set the published port to
   `3456` and attach a domain. Bots stay internal — never expose them.

4. **First boot.** The dashboard container runs Drizzle migrations against
   `/app/logs/auth.db` and seeds the admin user automatically before listening.
   Watch the logs to confirm `DB migrations applied` and
   `Admin seed: { created: true, ... }` appear.

## Required env vars per application

### `bot-15m` and `bot-5m`

Both bots accept the full set in `.env.example`. The minimum to enable real
trading:

```
POLYMARKET_LIVE_TRADING=true        # sole gate; default false = paper
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER=0x...
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_TRADE_AMOUNT=5
```

To keep a bot in paper-trading-only mode, leave `POLYMARKET_LIVE_TRADING`
unset (or set it to `false`) — the simulator and CSV logging still work even
if `POLYMARKET_PRIVATE_KEY` is configured. There is no separate `DRY_RUN`
switch any more.

### `dashboard`

```
BETTER_AUTH_SECRET=<openssl rand -base64 48>
BETTER_AUTH_URL=https://dashboard.example.com                  # the public URL Coolify exposes
AUTH_TRUSTED_ORIGINS=https://dashboard.example.com
DASHBOARD_ADMIN_EMAIL=you@example.com
DASHBOARD_ADMIN_PASSWORD=<minimum 12 chars>
DASHBOARD_ADMIN_NAME=Admin
```

`SQLITE_PATH` defaults to `/app/logs/auth.db` and rarely needs to be set
explicitly. Keep it inside the shared volume so the database persists across
redeploys.

To rotate the admin password without manual SQL: set
`DASHBOARD_ADMIN_RESET_PASSWORD=true`, change `DASHBOARD_ADMIN_PASSWORD`,
redeploy the dashboard, then flip the reset flag back to `false`.

## Environments (prod vs staging)

Use **two Coolify projects** so env vars, secrets and volumes are physically
isolated.

| Project   | Git branch | `POLYMARKET_LIVE_TRADING` | Trading key | Logs volume |
|-----------|------------|---------------------------|-------------|-------------|
| `prod`    | `main`     | `true`                    | real        | `polymarket-logs-prod` |
| `staging` | `staging`  | `false` (or unset)        | unset       | `polymarket-logs-staging` |

Each project gets its own `auth.db` (via its own logs volume). Never share an
admin user across environments — staging gets its own `DASHBOARD_ADMIN_*`
values.

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
- To back up auth state, copy `/app/logs/auth.db` (and the `auth.db-wal` /
  `auth.db-shm` sidecar files if present). SQLite WAL mode is enabled.
