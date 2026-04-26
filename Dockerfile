FROM node:22-alpine AS dashboard-builder
WORKDIR /build
COPY dashboard/package*.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY scripts/ ./scripts/
COPY entrypoint.sh /entrypoint.sh
COPY --from=dashboard-builder /build/dist ./dashboard/dist

RUN chmod +x /entrypoint.sh && mkdir -p logs

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/index.js"]
