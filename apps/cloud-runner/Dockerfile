FROM node:25-bookworm-slim

ARG CODEX_NPM_PACKAGE=@openai/codex

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client tini \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "${CODEX_NPM_PACKAGE}"

RUN groupadd --system --gid 10001 cloudcodex \
  && useradd --system --uid 10001 --gid cloudcodex --create-home --home-dir /home/cloudcodex --shell /usr/sbin/nologin cloudcodex

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/mac-runner-cli ./apps/mac-runner-cli
COPY apps/cloud-runner ./apps/cloud-runner

RUN mkdir -p /workspaces /codex-home /cloudcodex \
  && chown -R cloudcodex:cloudcodex /workspaces /codex-home /cloudcodex /app

USER 10001:10001

ENV CLOUD_CODEX_WORKSPACES_ROOT=/workspaces
ENV CLOUD_CODEX_RUNNER_HOME=/cloudcodex
ENV CLOUD_CODEX_SESSION_TOKEN_FILE=/cloudcodex/session.token
ENV CODEX_HOME=/codex-home
ENV HOME=/codex-home

VOLUME ["/workspaces", "/codex-home", "/cloudcodex"]

ENTRYPOINT ["tini", "--", "node", "apps/cloud-runner/src/index.ts"]
CMD ["daemon"]
