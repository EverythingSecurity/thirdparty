# syntax=docker/dockerfile:1.7
#
# @vsa/web — static SPA served by nginx.
#
# Multi-stage:
#   1. `build`   — Vite production build.
#   2. `runtime` — nginx:alpine serving /usr/share/nginx/html, with SPA
#                  fallback (all routes → index.html) and /api reverse-proxy
#                  to the API sidecar service.

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /repo
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm install --no-audit --no-fund
COPY apps/web apps/web/
COPY packages/shared packages/shared/
RUN npm run --workspace=@vsa/web build

# ---------- runtime ----------
FROM nginx:1.27-alpine AS runtime
RUN adduser -S vsa -G nginx
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
# nginx-alpine defaults to running as root inside the container; the
# Container Apps runtime enforces the effective user via revision spec.
