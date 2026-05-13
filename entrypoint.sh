#!/bin/sh
# Selects which bot to run from BOT_MODE and rotates large tick logs on every
# container start. Trade history (*_trades.csv) is preserved across deploys.
#
# BOT_MODE values:
#   15m (default) → node src/index.js   + rotates signals.csv,   dryrun_15m.csv
#   5m            → node src/index5m.js + rotates signals_5m.csv, dryrun_5m.csv
#
# Any argument passed to docker run / CMD overrides BOT_MODE selection.

TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
mkdir -p /app/logs/archive

MODE=${BOT_MODE:-15m}

case "$MODE" in
  5m)
    FILES="signals_5m.csv dryrun_5m.csv"
    DEFAULT_CMD="node --max-old-space-size=384 src/index5m.js"
    ;;
  15m)
    FILES="signals.csv dryrun_15m.csv"
    DEFAULT_CMD="node --max-old-space-size=384 src/index.js"
    ;;
  *)
    echo "entrypoint: unknown BOT_MODE='$MODE' (expected 15m or 5m)" >&2
    exit 1
    ;;
esac

for f in $FILES; do
  if [ -f "/app/logs/$f" ]; then
    gzip -c "/app/logs/$f" > "/app/logs/archive/${TIMESTAMP}_${f}.gz"
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
