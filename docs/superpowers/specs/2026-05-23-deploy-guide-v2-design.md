# Deploy Guide v2 — Coolify (staging + prod) — Design

**Status:** approved (design phase)
**Author:** brainstorming session 2026-05-23
**Supersedes:** `deploy/coolify/README.md` (still references the removed
`POLYMARKET_LIVE_TRADING` gate, lacks `EXECUTION_MODE`, capture service, and
the new `sim/`/`real/` log layout)

## Goal

Document how to deploy the project on Coolify with two isolated environments
(`staging` and `prod`) that:

- auto-deploy from separate Git branches (`staging` → staging project,
  `main` → prod project),
- run staging as a single Docker Compose stack (low friction),
- run prod as independent Coolify Applications (per-service start/stop), and
- reflect the current code state: `EXECUTION_MODE` as the sole real-trading
  gate, the optional `capture` bot under a compose profile, the role-aware
  log rotation in `entrypoint.sh`, and the `sim/`/`real/` log subdirs created
  by `scripts/migrateLogLayout.js`.

## Topology

| Coolify Project       | Git branch | Shape                          | EXECUTION_MODE | Capture           |
|-----------------------|------------|--------------------------------|----------------|-------------------|
| `polymarket-staging`  | `staging`  | 1 Docker Compose resource      | `paper`        | OFF (no profile)  |
| `polymarket-prod`     | `main`     | 4 independent Applications     | `real` (bots)  | ON (own App)      |

Each project lives on its own Coolify project (env vars, secrets, volumes,
admin DB are physically isolated). Webhooks redeploy on push to the matched
branch.

## Prod — four Coolify Applications

All four apps point at the same Git repo (`main`). One Project,
four Applications.

| App         | Build                       | BOT_MODE  | Public | Mounted volume(s)                                  | EXECUTION_MODE |
|-------------|-----------------------------|-----------|--------|----------------------------------------------------|----------------|
| `bot-15m`   | `Dockerfile`                | `15m`     | no     | `polymarket-logs-prod` → `/app/logs`               | `real`         |
| `bot-5m`    | `Dockerfile`                | `5m`      | no     | `polymarket-logs-prod` → `/app/logs`               | `real`         |
| `capture`   | `Dockerfile`                | `capture` | no     | `polymarket-capture-prod` → `/app/logs` (isolated) | n/a            |
| `dashboard` | `Dockerfile.dashboard`      | n/a       | yes    | `polymarket-logs-prod` → `/app/logs`               | n/a            |

Key points:

- Three Apps (bots + dashboard) share `polymarket-logs-prod` via Coolify
  Shared Storage. The capture bot uses a separate volume
  (`polymarket-capture-prod`) so its high-frequency orderbook dumps never
  pollute the bots' CSVs or the auth DB.
- Per-service start/stop is a single button per App in the Coolify UI.
  Pausing `capture` for weeks does not affect bots; stopping `bot-5m` to
  investigate drift does not affect `bot-15m`.
- `auth.db` (better-sqlite3, WAL mode) lives at `/app/logs/auth.db` inside
  the shared volume. Only the dashboard reads/writes it.

### Required env vars (prod)

Common to both bots (`bot-15m`, `bot-5m`):

```
EXECUTION_MODE=real
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER=0x...
POLYMARKET_SIGNATURE_TYPE=2   # 0=EOA, 1=POLY_PROXY, 2=GnosisSafe, 3=POLY_1271
POLYMARKET_TRADE_AMOUNT=5
TRADE_SLIPPAGE_TOLERANCE_PCT=0.02
TRADE_TAKER_BUFFER=0.05
```

Per-App overrides:

- `bot-15m`: `BOT_MODE=15m`
- `bot-5m`:  `BOT_MODE=5m`
- `capture`: `BOT_MODE=capture` (does NOT need the trading key — capture only
  reads the orderbook)

`dashboard`:

```
BETTER_AUTH_SECRET=<openssl rand -base64 48>
BETTER_AUTH_URL=https://dashboard.example.com
AUTH_TRUSTED_ORIGINS=https://dashboard.example.com
DASHBOARD_ADMIN_EMAIL=you@example.com
DASHBOARD_ADMIN_PASSWORD=<>=12 chars>
DASHBOARD_ADMIN_NAME=Admin
DASHBOARD_TRADE_SOURCE=real    # prod renders real_*_trades.csv
# SQLITE_PATH defaults to /app/logs/auth.db
```

Secrets must be stored as Coolify "Secrets" rather than plain env vars.

## Staging — one Docker Compose resource

Coolify Project `polymarket-staging`, branch `staging`, resource type
"Docker Compose", pointing at the repo's `docker-compose.yml`.

Services that come up by default: `bot-15m`, `bot-5m`, `dashboard`.
The `capture` service is gated by `profiles: ["capture"]` in compose and
stays OFF in staging (no `COMPOSE_PROFILES=capture`, no `--profile capture`
flag).

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

Domain: attach `staging-dashboard.example.com` to the `dashboard` service in
the Coolify UI (port 3456).

Redeploy = one button rebuilds the whole stack. Individual start/stop is not
a goal in staging — staging is a monolithic validation stack.

## Volumes & log layout

Prod volumes:

- `polymarket-logs-prod` (Coolify Shared Storage) → mounted on `bot-15m`,
  `bot-5m`, and `dashboard` at `/app/logs`.
- `polymarket-capture-prod` (Coolify Shared Storage) → mounted on `capture`
  only at `/app/logs`.

Staging volumes: the named volumes `polymarket_logs` and `polymarket_capture`
declared in `docker-compose.yml`. `polymarket_capture` stays empty in
staging (the capture service does not run) — zero cost.

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
boot — idempotent, moves any legacy flat CSVs into the `sim/` / `real/`
subdirs. No manual migration needed for existing volumes.

Backup targets (worth periodic `cp`): `auth.db*`, `*_trades.csv` (both `sim/`
and `real/`), `strategy_versions_*.json`. Tick CSVs (`signals*`, `dryrun*`,
`ticks*`) are disposable — rotated on each restart.

## CI/CD & branch flow

Webhooks:

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

Tweaking an env var in prod (e.g. raising `TRADE_TAKER_BUFFER`): edit on the
target App in Coolify → Restart. No image rebuild.

Rollback per service in prod: Coolify keeps deploy history per App.
"Redeploy previous" on `bot-5m` rolls back only `bot-5m`.

Build cache note: `Dockerfile` is shared by three Apps (`bot-15m`, `bot-5m`,
`capture`). A push to `main` triggers three rebuilds; Coolify reuses layer
cache, so only `COPY src/` and downstream layers re-execute.

## Operations

- **Per-service start/stop (prod):** Coolify App page → Stop / Start.
- **Soft kill switch (stop trading, keep logging):** set
  `EXECUTION_MODE=paper` on `bot-15m` and `bot-5m` → Restart. Orders stop,
  CSVs keep flowing.
- **Hard kill switch:** Stop the two bot Apps. Dashboard + capture stay up.
- **Admin password reset:** set `DASHBOARD_ADMIN_RESET_PASSWORD=true`
  alongside a new `DASHBOARD_ADMIN_PASSWORD` → Restart dashboard → flip
  the reset flag back to `false`.
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

## Migrating from the existing setup

If a Coolify install still follows the old `deploy/coolify/README.md`:

1. Remove `POLYMARKET_LIVE_TRADING` from every App — the flag is gone
   (commit `2525e4f`, "drop legacy POLYMARKET_LIVE_TRADING gate").
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

## Non-goals

- High-availability / multi-instance bots. The CLOB position tracker is
  in-memory; running two instances of `bot-15m` would double-trade.
- Postgres / external database. SQLite + WAL in the shared logs volume is
  sufficient and explicitly chosen (commit `944755e`).
- Per-service auto-deploy in staging. Staging is a single rebuild on
  every staging-branch push, by design.

## Open questions

None at design time. Implementation will: (1) rewrite
`deploy/coolify/README.md` to match this spec, (2) make sure
`docker-compose.yml` and `entrypoint.sh` already match the documented
behavior (they do as of `2525e4f` / `d679549` / `5498b32`), and (3) drop
stale references to `POLYMARKET_LIVE_TRADING` from the README.
