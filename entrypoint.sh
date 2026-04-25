#!/bin/sh
# Rotates large tick logs on every container start.
# Trade history (*_trades.csv) is preserved across deploys.
TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
mkdir -p /app/logs/archive

for f in signals.csv signals_5m.csv dryrun_15m.csv dryrun_5m.csv; do
  if [ -f "/app/logs/$f" ]; then
    gzip -c "/app/logs/$f" > "/app/logs/archive/${TIMESTAMP}_${f}.gz"
    rm "/app/logs/$f"
  fi
done

# delete archives older than 14 days
find /app/logs/archive -name "*.gz" -mtime +14 -delete

exec "$@"
