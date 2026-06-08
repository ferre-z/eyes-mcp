# syntax=docker/dockerfile:1.7
# ---------- build stage ----------
FROM node:20-alpine AS build
WORKDIR /app

# Install deps first for layer caching
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy source and compile
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies for the runtime image
RUN npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:20-alpine AS runtime
WORKDIR /app

# wget is used by HEALTHCHECK (busybox has it; explicit is clearer).
RUN apk add --no-cache wget tini

# Run as the built-in non-root "node" user (uid 1000)
USER node

ENV NODE_ENV=production \
    EYES_HTTP_HOST=0.0.0.0 \
    EYES_HTTP_PORT=8787 \
    EYES_DATA_DIR=/data

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

# tini gives us proper signal forwarding for graceful shutdown
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
