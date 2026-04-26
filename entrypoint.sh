#!/bin/sh
# Rotates large tick logs on every container start.
# Trade history (*_trades.csv) is preserved across deploys.
TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
mkdir -p /app/logs/archive

# Rotate only the files owned by this bot, determined by the command argument.
# bot-15m (index.js): signals.csv + dryrun_15m.csv
# bot-5m (index5m.js): signals_5m.csv + dryrun_5m.csv
case "$*" in
  *index5m*)
    FILES="signals_5m.csv dryrun_5m.csv"
    ;;
  *index*)
    FILES="signals.csv dryrun_15m.csv"
    ;;
  *)
    FILES=""
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

exec "$@"
