# syntax=docker/dockerfile:1
# ==============================================================================
# cs-devtest credential broker — multi-stage, non-root.
# ==============================================================================

# ---- build stage: install production dependencies -----------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---- runtime stage ------------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .
# node:20-alpine ships an unprivileged "node" user — run as it, never root.
USER node
EXPOSE 8900
CMD ["node", "server.js"]
