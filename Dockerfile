# syntax=docker/dockerfile:1.7
# HN Sentinel: one container runs the collector, the API, and serves the React app.

ARG NODE_VERSION=24

# --- Dependencies (dev tooling only; the runtime needs none) ---
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# --- Verify and build: the image is only produced when typecheck and tests pass ---
FROM deps AS build
COPY . .
RUN npm run typecheck \
 && npm test \
 && npm run build

# --- Runtime: Node runs the TypeScript server directly; SQLite is built into Node ---
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health > /dev/null || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
