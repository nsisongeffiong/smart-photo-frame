# smart-photo-frame — production image.
#
# Rename to `Dockerfile` before building; this file ships as Dockerfile.txt
# only because the release extractor requires a dotted extension.
#
# Deliberately absent: photos.  The album tree is operator data and lives on a
# persistent volume mounted at /photos, never inside the image.  Baking photos
# in would make every redeploy a full re-upload and would put private images
# into the registry.

FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

# Copy the manifest and the lockfile first so that dependency installation is
# cached independently of application code.  npm ci refuses to run without a
# lockfile, which is the point: builds are reproducible or they fail.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application code only.  public/ holds the iOS 12 compatible client page.
COPY server.js ./
COPY public ./public

# node:20-alpine ships an unprivileged `node` user (uid 1000).  /photos is
# created here so the mount point exists even when no volume is attached; the
# volume is mounted read-only in normal operation.
RUN mkdir -p /photos \
 && chown -R node:node /app /photos

USER node

# The health probe checks that the HTTP surface is alive, not that Home
# Assistant is reachable.  During an HA outage the frame must keep serving the
# last known album, so a failing HA poll must not mark the container unhealthy
# and trigger a restart loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'const http=require("http");const port=process.env.PORT||3000;const req=http.get({host:"127.0.0.1",port:port,path:"/healthz",timeout:4000},function(res){res.resume();process.exit(res.statusCode===200?0:1);});req.on("timeout",function(){req.destroy();process.exit(1);});req.on("error",function(){process.exit(1);});'

CMD ["node", "server.js"]
