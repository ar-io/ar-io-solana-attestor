# Monorepo-aware build for the attestor service.
# BUILD CONTEXT MUST BE THE REPO ROOT (see docker-compose.yml), because
# the attestor imports the sibling workspace @ar.io/attestor-canonical.
#
#   docker build -f packages/attestor/Dockerfile -t ar-io-escrow-attestor .

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

# Sources needed to build the attestor: the shared lib + the service.
COPY packages/canonical ./packages/canonical
COPY packages/attestor ./packages/attestor

# Build the shared lib first (emits dist + .d.ts), then the service.
RUN yarn workspace @ar.io/attestor-canonical build \
 && yarn workspace @ar.io/escrow-attestor build

# Drop dev deps (tsx/typescript). Workspace symlinks are preserved.
RUN yarn install --frozen-lockfile --production --ignore-scripts

# --- runtime ---
FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/package.json ./package.json
# The workspace symlink node_modules/@ar.io/attestor-canonical resolves
# to /app/packages/canonical, so its built dist + manifest must be present.
COPY --from=builder --chown=app:app /app/packages/canonical/dist ./packages/canonical/dist
COPY --from=builder --chown=app:app /app/packages/canonical/package.json ./packages/canonical/package.json
COPY --from=builder --chown=app:app /app/packages/attestor/dist ./packages/attestor/dist
COPY --from=builder --chown=app:app /app/packages/attestor/package.json ./packages/attestor/package.json

USER app

# Plain HTTP — TLS terminates at the reverse proxy (Cloudflare, ALB, nginx).
EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3030) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "packages/attestor/dist/index.js"]
