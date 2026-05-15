# --- builder ---
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies (cached layer when package.json/yarn.lock unchanged)
COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile

# Build TS → JS
COPY tsconfig.json ./
COPY src ./src
RUN yarn build

# Drop dev deps from node_modules
RUN yarn install --frozen-lockfile --production --ignore-scripts

# --- runtime ---
FROM node:20-alpine

# Run as non-root user (security baseline)
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/package.json ./package.json

USER app

# The service speaks plain HTTP — TLS is the responsibility of the
# reverse proxy in front (Cloudflare, ALB, nginx).
EXPOSE 3030

# Health check pings GET /health every 30s. Container marked unhealthy
# after 3 consecutive failures.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3030) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
