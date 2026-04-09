FROM node:22-slim

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files first (cache layer)
COPY package.json pnpm-lock.yaml ./

# Install dependencies (including native better-sqlite3)
RUN pnpm install --frozen-lockfile

# Copy source
COPY src/ src/
COPY demo/ demo/
COPY tsconfig.json tsup.config.ts vitest.config.ts ./

# Data directory for mesh storage
RUN mkdir -p /data/mesh
ENV MESH_DATA_DIR=/data/mesh

# Default port
EXPOSE 4001

# Default: run the persistent node daemon (env-driven, persists PeerID).
# Use node directly (not `pnpm exec`) — pnpm's wrapper duplicates child
# process output through Docker's log driver, causing every line to appear
# twice in `docker logs`.
ENTRYPOINT ["node", "--import", "tsx", "src/daemon.ts"]
