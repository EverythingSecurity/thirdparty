# syntax=docker/dockerfile:1.7
#
# @vsa/api — Fastify API container.
#
# Multi-stage:
#   1. `deps`     — install ALL workspaces (needed for tsc + prisma generate).
#   2. `build`    — compile TS → JS, generate Prisma client.
#   3. `runtime`  — copy just the built API + prod-only node_modules; non-root user.
#
# Notes:
#   - We install from the repo root because workspace hoisting means
#     apps/api/node_modules alone is incomplete.
#   - Prisma's linux-musl-openssl-3.0.x binary is generated at build time
#     (see schema.prisma `binaryTargets`).
#   - The image doesn't ship secrets — env comes from Container App KV refs.

# ---------- deps ----------
FROM node:20-alpine AS deps
WORKDIR /repo
RUN apk add --no-cache openssl python3 make g++
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY db/package.json db/
COPY packages/shared/package.json packages/shared/
# npm install rather than ci — the lockfile may not exist yet in dev
# repos; CI/CD should pass a pre-locked repo.
RUN npm install --no-audit --no-fund

# ---------- build ----------
FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json ./
COPY apps/api apps/api/
COPY db db/
COPY packages/shared packages/shared/
# Generate the Prisma client with the alpine binary target.
RUN npx --workspace=@vsa/db prisma generate
# Compile the API. Workspace packages export .ts source directly (per Sprint 1),
# so the API's tsc doesn't need to build them first.
RUN npm run --workspace=@vsa/api build

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl tini \
    && addgroup -S vsa && adduser -S vsa -G vsa

# Copy the built API + its transitive deps.
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./package.json
COPY --from=build /repo/node_modules ./node_modules
# Prisma client artifacts + schema (schema is needed at runtime for `prisma db execute`).
COPY --from=build /repo/db/prisma ./db/prisma
COPY --from=build /repo/packages/shared ./packages/shared

USER vsa
EXPOSE 4000
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=4000

# tini reaps zombies + forwards signals — matters for graceful shutdown
# during Container Apps revision swaps.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
