FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY scripts/ ./scripts/
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh && mkdir -p logs

# Bot selection is driven by the BOT_MODE env var (15m | 5m).
# See entrypoint.sh. No CMD: the entrypoint picks the script from BOT_MODE.
ENTRYPOINT ["/entrypoint.sh"]
