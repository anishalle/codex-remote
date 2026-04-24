FROM node:25-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 cloudcodex \
  && useradd --system --uid 10001 --gid cloudcodex --create-home --home-dir /home/cloudcodex --shell /usr/sbin/nologin cloudcodex

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/cloud-server ./apps/cloud-server
COPY apps/mobile-web ./apps/mobile-web

RUN mkdir -p /data \
  && chown -R cloudcodex:cloudcodex /data /app

USER 10001:10001

ENV CLOUD_CODEX_HOST=0.0.0.0
ENV CLOUD_CODEX_PORT=8787
ENV CLOUD_CODEX_DB_PATH=/data/cloudcodex.sqlite
ENV CLOUD_CODEX_UPLOAD_DIR=/data/uploads

VOLUME ["/data"]
EXPOSE 8787

ENTRYPOINT ["tini", "--", "node", "apps/cloud-server/src/index.ts"]
