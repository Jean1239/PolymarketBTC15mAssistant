# Coolify deployment

Two-environment Coolify deployment for the project:

- **`polymarket-staging`** — single Docker Compose resource, branch `staging`, `EXECUTION_MODE=paper`, capture service OFF.
- **`polymarket-prod`** — four independent Coolify Applications, branch `main`, `EXECUTION_MODE=real`, capture service ON (own volume).

Webhooks redeploy each project on push to its matched branch. Env vars,
secrets, volumes, and the admin database are physically isolated per
project.

## Topology

| Coolify Project       | Git branch | Shape                          | EXECUTION_MODE | Capture           |
|-----------------------|------------|--------------------------------|----------------|-------------------|
| `polymarket-staging`  | `staging`  | 1 Docker Compose resource      | `paper`        | OFF (no profile)  |
| `polymarket-prod`     | `main`     | 4 independent Applications     | `real` (bots)  | ON (own App)      |

## Prod — four Coolify Applications

All four apps point at the same Git repo (`main`). One Project, four
Applications.

| App         | Build                       | BOT_MODE  | Public | Mounted volume(s)                                  | EXECUTION_MODE |
|-------------|-----------------------------|-----------|--------|----------------------------------------------------|----------------|
| `bot-15m`   | `Dockerfile`                | `15m`     | no     | `polymarket-logs-prod` → `/app/logs`               | `real`         |
| `bot-5m`    | `Dockerfile`                | `5m`      | no     | `polymarket-logs-prod` → `/app/logs`               | `real`         |
| `capture`   | `Dockerfile`                | `capture` | no     | `polymarket-capture-prod` → `/app/logs` (isolated) | n/a            |
| `dashboard` | `Dockerfile.dashboard`      | n/a       | yes    | `polymarket-logs-prod` → `/app/logs`               | n/a            |

- Three Apps (bots + dashboard) share `polymarket-logs-prod` via Coolify
  Shared Storage. The capture bot has its own volume
  (`polymarket-capture-prod`) so its high-frequency orderbook dumps never
  pollute the bots' CSVs or the auth DB.
- Per-service start/stop is a single button per App in the Coolify UI.
  Pausing `capture` for weeks does not affect bots; stopping `bot-5m` to
  investigate drift does not affect `bot-15m`.
- `auth.db` (better-sqlite3, WAL mode) lives at `/app/logs/auth.db` inside
  the shared volume. Only the dashboard reads/writes it.
- Coolify's Application + Dockerfile build pack has no Start Command field;
  the bot script is selected entirely by `BOT_MODE`. To run a different
  bot, change the env var and redeploy — no Dockerfile edit needed.

### One-time setup (prod)

1. **Create the two Shared Storage volumes** (Project → Storages → New
   shared volume): `polymarket-logs-prod` and `polymarket-capture-prod`,
   both mounted at `/app/logs` when attached to apps.
2. **Create the four Applications**, all pointing at the repo, branch `main`:
   - `bot-15m`   → Dockerfile `Dockerfile`, env `BOT_MODE=15m`, attach `polymarket-logs-prod`
   - `bot-5m`    → Dockerfile `Dockerfile`, env `BOT_MODE=5m`,  attach `polymarket-logs-prod`
   - `capture`   → Dockerfile `Dockerfile`, env `BOT_MODE=capture`, attach `polymarket-capture-prod`
   - `dashboard` → Dockerfile `Dockerfile.dashboard`, attach `polymarket-logs-prod`, expose port 3456 with a domain
3. **Paste env vars** (see *Required env vars* below). Put secrets in
   Coolify "Secrets", not plain env.
4. **First boot of `dashboard`** runs Drizzle migrations against
   `/app/logs/auth.db` and seeds the admin user. Watch the logs for
   `DB migrations applied` and `Admin seed: { created: true, ... }`.

### Required env vars (prod)

Common to both bots (`bot-15m`, `bot-5m`):

```
EXECUTION_MODE=real
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER=0x...
POLYMARKET_SIGNATURE_TYPE=2          # 0=EOA, 1=POLY_PROXY, 2=GnosisSafe, 3=POLY_1271
POLYMARKET_TRADE_AMOUNT=5
TRADE_SLIPPAGE_TOLERANCE_PCT=0.02
TRADE_TAKER_BUFFER=0.05
```

Per-App overrides:

- `bot-15m`: `BOT_MODE=15m`
- `bot-5m`:  `BOT_MODE=5m`
- `capture`: `BOT_MODE=capture` (does NOT need the trading key — capture
  only reads the orderbook)

To keep a bot in paper mode in prod (e.g. while validating a tweak), set
`EXECUTION_MODE=paper` on just that App. The simulator and CSV logging
still run.

`dashboard`:

```
BETTER_AUTH_SECRET=<openssl rand -base64 48>
BETTER_AUTH_URL=https://dashboard.example.com
AUTH_TRUSTED_ORIGINS=https://dashboard.example.com
DASHBOARD_ADMIN_EMAIL=you@example.com
DASHBOARD_ADMIN_PASSWORD=<>=12 chars>
DASHBOARD_ADMIN_NAME=Admin
DASHBOARD_TRADE_SOURCE=real          # prod renders real_*_trades.csv
# SQLITE_PATH defaults to /app/logs/auth.db — rarely needs to be set
```

To rotate the admin password without manual SQL: set
`DASHBOARD_ADMIN_RESET_PASSWORD=true`, update `DASHBOARD_ADMIN_PASSWORD`,
redeploy the dashboard, then flip the reset flag back to `false`.

## Staging — one Docker Compose resource

Coolify Project `polymarket-staging`, branch `staging`, resource type
"Docker Compose", pointing at the repo's `docker-compose.yml`.

Services that come up by default: `bot-15m`, `bot-5m`, `dashboard`. The
`capture` service is gated by `profiles: ["capture"]` in compose and stays
OFF in staging (no `COMPOSE_PROFILES=capture` set).

Project-level env vars (compose inherits — no need to repeat per service):

```
EXECUTION_MODE=paper
BETTER_AUTH_URL=https://staging-dashboard.example.com
AUTH_TRUSTED_ORIGINS=https://staging-dashboard.example.com
BETTER_AUTH_SECRET=<openssl rand -base64 48>   # different from prod
DASHBOARD_ADMIN_EMAIL=staging@example.com
DASHBOARD_ADMIN_PASSWORD=<>=12 chars>
DASHBOARD_ADMIN_NAME=Staging Admin
DASHBOARD_TRADE_SOURCE=sim
# POLYMARKET_PRIVATE_KEY intentionally unset — paper mode does not need it
```

Volumes: `polymarket_logs` and `polymarket_capture` from compose become
named volumes scoped to the staging project (no collision with prod).
`polymarket_capture` stays empty in staging (capture does not run) — zero
cost.

Domain: attach `staging-dashboard.example.com` to the `dashboard` service
via the Coolify UI (port 3456).

Redeploy = one button rebuilds the whole stack. Per-service start/stop is
not a goal in staging — staging is a monolithic validation stack.

## Volumes & log layout

Prod volumes (Coolify Shared Storage):

- `polymarket-logs-prod` → mounted on `bot-15m`, `bot-5m`, `dashboard` at
  `/app/logs`.
- `polymarket-capture-prod` → mounted on `capture` only at `/app/logs`.

Staging volumes: the named volumes `polymarket_logs` and
`polymarket_capture` declared in `docker-compose.yml`.

Layout inside `/app/logs/`:

```
sim/
  signals.csv, signals_5m.csv
  dryrun_15m.csv, dryrun_5m.csv
  dryrun_15m_trades.csv, dryrun_5m_trades.csv
real/
  ticks_15m.csv, ticks_5m.csv
  real_15m_trades.csv, real_5m_trades.csv
archive/                          # role-aware gzip rotation, 14-day retention
strategy_versions_{15m,5m}.json
polymarket_market_<slug>.json
auth.db, auth.db-wal, auth.db-shm # better-sqlite3 WAL
trade_orders.log, trade_errors.log
```

`scripts/migrateLogLayout.js` runs in the entrypoint on every container
boot — idempotent, moves any legacy flat CSVs into `sim/` and `real/`.

Backup targets (worth periodic `cp`): `auth.db*`, `*_trades.csv` (both
`sim/` and `real/`), `strategy_versions_*.json`. Tick CSVs are disposable
— rotated on each restart.

## CI/CD & branch flow

| Project              | Branch     | Auto-deploy effect                          |
|----------------------|------------|---------------------------------------------|
| `polymarket-staging` | `staging`  | rebuild the compose resource (all services) |
| `polymarket-prod`    | `main`     | rebuild only the Apps whose context changed |

Recommended flow:

```bash
# 1. Branch off staging
git switch staging && git pull
git switch -c feature/x
# ...edit code...
git push origin feature/x
gh pr create --base staging

# 2. Merge → staging Coolify auto-deploys compose
gh pr merge --squash --base staging

# 3. Soak in paper for 1-3 days
#    (dashboard staging shows sim trades because DASHBOARD_TRADE_SOURCE=sim)

# 4. Promote to prod
git switch main && git pull
git merge staging --ff-only
git push origin main           # Coolify prod rebuilds affected Apps
```

Tweaking an env var in prod (e.g. raising `TRADE_TAKER_BUFFER`): edit on
the target App in Coolify → Restart. No image rebuild.

Rollback per service in prod: Coolify keeps deploy history per App.
"Redeploy previous" on `bot-5m` rolls back only `bot-5m`.

Build cache: `Dockerfile` is shared by three Apps (`bot-15m`, `bot-5m`,
`capture`). A push to `main` triggers three rebuilds; Coolify reuses layer
cache, so only `COPY src/` and downstream layers re-execute.

## Operations

- **Per-service start/stop (prod):** Coolify App page → Stop / Start.
- **Soft kill switch (stop trading, keep logging):** set
  `EXECUTION_MODE=paper` on `bot-15m` and `bot-5m` → Restart. Orders stop,
  CSVs keep flowing.
- **Hard kill switch:** Stop the two bot Apps. Dashboard + capture stay up.
- **Admin password reset:** set `DASHBOARD_ADMIN_RESET_PASSWORD=true`,
  update `DASHBOARD_ADMIN_PASSWORD`, redeploy the dashboard, flip the
  reset flag back to `false`.
- **Log wipe:** `POST /api/logs/clear` (authenticated) archives current
  CSVs to `logs/archive/<timestamp>/` and truncates. In prod this also
  zeros out `real_*_trades.csv` — handle with care.
- **Auto-redeem:** every market slug change with `EXECUTION_MODE=real`
  invokes `src/trading/redeem.js`. Outcome logged to
  `/app/logs/trade_orders.log`.
- **Health check (Coolify):** dashboard uses `GET /api/health` (public).
  Bots and capture rely on Docker's container-running check.
- **Live logs:** Coolify UI → App → Logs. Persistent via json-file driver
  (max 10 MB × 3 files per container).

## Migrating from the previous setup

If a Coolify install still follows the older version of this guide:

1. Remove `POLYMARKET_LIVE_TRADING` from every App — the flag is gone
   (commit `2525e4f`). `EXECUTION_MODE` is now the sole real-trading gate.
2. Set `EXECUTION_MODE=real` on `bot-15m` and `bot-5m` in prod (use
   `paper` if you want a temporary dry run before flipping live).
3. Create the new `capture` App in the prod project:
   - Build: `Dockerfile`
   - Env: `BOT_MODE=capture`
   - Volume: new Shared Storage `polymarket-capture-prod` → `/app/logs`
4. First container boot runs `scripts/migrateLogLayout.js`, which moves
   any legacy flat CSVs into `sim/` and `real/` subdirectories. No
   manual file shuffling required.
5. Switch staging to the new "Docker Compose" resource type (delete the
   old per-App staging setup if it existed). Compose volumes are
   recreated automatically; staging holds no production-relevant state.
