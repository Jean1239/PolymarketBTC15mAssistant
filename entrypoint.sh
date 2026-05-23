#!/bin/sh
# Selects which bot to run from BOT_MODE and rotates large tick logs on every
# container start. Trade history (*_trades.csv) is preserved across deploys.
#
# BOT_MODE values:
#   15m (default) → node src/index.js
#   5m            → node src/index5m.js
#   capture       → node src/indexCapture.js (no rotation; capture gzips itself)
#
# EXECUTION_MODE picks rotation targets for 15m/5m:
#   paper → sim/signals*.csv + sim/dryrun*.csv
#   real  → real/ticks*.csv
#
# Any argument passed to docker run / CMD overrides BOT_MODE selection.

TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
mkdir -p /app/logs/archive

# Migração one-shot idempotente — move arquivos flat antigos pros subdirs.
node /app/scripts/migrateLogLayout.js || echo "[entrypoint] migration warned (non-fatal)"

MODE=${BOT_MODE:-15m}
EXEC_MODE=${EXECUTION_MODE:-paper}

case "$MODE" in
  5m)
    if [ "$EXEC_MODE" = "real" ]; then
      FILES="real/ticks_5m.csv"
    else
      FILES="sim/signals_5m.csv sim/dryrun_5m.csv"
    fi
    DEFAULT_CMD="node --max-old-space-size=384 src/index5m.js"
    ;;
  15m)
    if [ "$EXEC_MODE" = "real" ]; then
      FILES="real/ticks_15m.csv"
    else
      FILES="sim/signals.csv sim/dryrun_15m.csv"
    fi
    DEFAULT_CMD="node --max-old-space-size=384 src/index.js"
    ;;
  capture)
    FILES=""
    DEFAULT_CMD="node --max-old-space-size=256 src/indexCapture.js"
    ;;
  *)
    echo "entrypoint: unknown BOT_MODE='$MODE' (expected 15m, 5m, or capture)" >&2
    exit 1
    ;;
esac

for f in $FILES; do
  if [ -f "/app/logs/$f" ]; then
    fname=$(basename "$f")
    gzip -c "/app/logs/$f" > "/app/logs/archive/${TIMESTAMP}_${fname}.gz"
    rm "/app/logs/$f"
  fi
done

# delete archives older than 14 days
find /app/logs/archive -name "*.gz" -mtime +14 -delete

if [ "$#" -gt 0 ]; then
  exec "$@"
else
  exec sh -c "$DEFAULT_CMD"
fi
