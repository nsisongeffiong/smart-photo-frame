# Photo-frame uploader. Node 22 is in active LTS (Node 20 reached end of life
# in April 2026). sharp ships prebuilt musl binaries, so no compiler is needed.
FROM node:22.23.4-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so this layer is cached until the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public

# Runs as an unprivileged user. docker-compose.yaml overrides the uid:gid so the
# files it writes are owned by whoever owns the photo folder on the host.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
