# Monorepo-aware build for the claims service.
# BUILD CONTEXT MUST BE THE REPO ROOT (see docker-compose.yml).
#
#   docker build -f packages/claims/Dockerfile -t ar-io-claims .

# --- builder ---
FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app

# Manifests first for a cached install layer. All workspace package.json
# files are required for yarn to validate the workspace graph.
COPY package.json yarn.lock tsconfig.base.json ./
COPY packages/canonical/package.json ./packages/canonical/
COPY packages/attestor/package.json ./packages/attestor/
COPY packages/claims/package.json ./packages/claims/
RUN yarn install --frozen-lockfile

# Only the claims service source is needed to build it.
COPY packages/claims ./packages/claims
RUN yarn workspace @ar.io/claims build

# Drop dev deps. Workspace symlinks are preserved.
RUN yarn install --frozen-lockfile --production --ignore-scripts

# --- runtime ---
FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/package.json ./package.json
COPY --from=builder --chown=app:app /app/packages/claims/dist ./packages/claims/dist
COPY --from=builder --chown=app:app /app/packages/claims/migrations ./packages/claims/migrations
COPY --from=builder --chown=app:app /app/packages/claims/package.json ./packages/claims/package.json

USER app

# Plain HTTP — TLS terminates at the reverse proxy.
EXPOSE 3040

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3040) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "packages/claims/dist/index.js"]
