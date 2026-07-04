# Macrotide — containerized self-host image.
#
# Single Next.js process over a local SQLite file (better-sqlite3, a native
# module). Two stages: a builder that compiles the native module + runs
# `next build`, and a slim runner.
#
# We deliberately ship the full source tree + node_modules (not a `standalone`
# trace) into the runner because:
#   - migrate() reads the SQL files in lib/db/migrations/ from disk at startup
#     (resolved relative to WORKDIR), and
#   - the fund-catalog refresh job runs the TypeScript in scripts/ + lib/ via
#     `tsx` (a devDependency) through `docker compose run --rm --no-deps`.
# A standalone trace would drop both. Image size is a non-issue on the target.

FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Toolchain for better-sqlite3's node-gyp build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# lib/auth reads AUTH_SECRET at module-eval, and Next sets NODE_ENV=production
# during `next build` — so a value must be present at BUILD time or page-data
# collection throws. This placeholder is build-only and never signs real
# sessions; the runtime secret comes from compose `env_file` (.env.local).
# Mirrors the CI build step.
RUN AUTH_SECRET=docker-build-placeholder-not-used-at-runtime-32chars npm run build

# ── Runner ───────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/app.db \
    MARKET_DB_PATH=/app/data/market.db

# Everything from the builder: compiled node_modules (better-sqlite3 .node built
# for this arch), the .next build, source (migrations + job scripts), configs.
COPY --from=builder /app ./

# The SQLite file + daily backups live here; mounted as a volume at runtime.
# node_modules already owns uid 1000 (the `node` user); align /app/data too.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000

# Node 24 has global fetch — no extra packages needed for the healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
