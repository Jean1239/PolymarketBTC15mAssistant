FROM node:22-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

# Logs dir (will be overridden by volume mount, but good to have)
RUN mkdir -p logs

CMD ["node", "src/index.js"]
