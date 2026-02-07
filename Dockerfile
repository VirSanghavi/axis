FROM oven/bun:latest AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Environment Defaults
ENV NODE_ENV=production
ENV PORT=3000

# Start script depends on whether we want API or Server
# Defaulting to API for this container
CMD ["bun", "run", "src/api/index.ts"]
