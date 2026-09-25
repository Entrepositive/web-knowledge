# Build stage: has a compiler toolchain so better-sqlite3's native module
# builds even on platforms without a prebuilt binary.
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# All runtime state (config.env + knowledge.db) lives here — mount it.
VOLUME ["/app/data"]
EXPOSE 4242

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4242/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
