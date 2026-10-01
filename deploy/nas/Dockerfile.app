FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY shared/ ./shared/
COPY server/ ./server/
COPY cloudfunctions/api/ ./cloudfunctions/api/
COPY cloudfunctions/worker/ ./cloudfunctions/worker/
COPY scripts/sync-shared.mjs ./scripts/sync-shared.mjs
COPY scripts/local-media-manifest.mjs scripts/local-media-receiver.mjs ./scripts/
RUN node scripts/sync-shared.mjs \
    && mkdir -p /data/private-media \
    && chown node:node /data/private-media

COPY deploy/nas/entrypoint-app.sh /usr/local/bin/entrypoint-app.sh
RUN chmod 0755 /usr/local/bin/entrypoint-app.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV NAS_MEDIA_DIR=/data/private-media
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint-app.sh"]
CMD ["npm", "start"]
