# syntax=docker/dockerfile:1

# ─── deps ─────────────────────────────────────────────────────────────────────
# The runtime image is oven/bun, which ships no node and no npm, so pnpm cannot
# run there. This stage exists only to resolve node_modules from the committed
# pnpm-lock.yaml — keeping that lockfile authoritative instead of letting
# `bun install` re-resolve the tree and quietly drift from what CI tested.
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --prod drops drizzle-kit and with it esbuild, whose postinstall shells out to
# `node install.js`. That postinstall is what broke the first hosted build.
# Nothing the running server does needs either: migrations use drizzle-orm's own
# migrator (see src/database/migrate.ts), not drizzle-kit.
RUN pnpm install --prod --frozen-lockfile

# ─── runtime ──────────────────────────────────────────────────────────────────
FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# No build step and no dist/: Bun executes TypeScript directly, and tsconfig's
# path aliases resolve natively. `pnpm build` exists for CI typechecking only.

# `bun` is a non-root user created by the base image. Nothing here needs to
# write to disk, so the filesystem can also be mounted read-only by the
# platform if it supports it.
USER bun

EXPOSE 4000

# Liveness, not readiness: /health touches no dependency, so a transient Neon
# blip does not get the container killed and restarted into the same blip.
# Readiness lives at /api/v1/health/ready for the platform's own probe.
# Probed with bun rather than wget: wget's presence in this base image is an
# assumption, bun's is not.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch(`http://127.0.0.1:${process.env.PORT??4000}/api/v1/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "src/main.ts"]
