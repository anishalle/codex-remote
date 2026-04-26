FROM oven/bun:1.3.11

ARG CODEX_NPM_PACKAGE=@openai/codex

ENV BUN_INSTALL=/usr/local/bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl g++ gh git make nodejs npm openssh-client python3 ripgrep tini \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && . /etc/os-release \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

RUN bun add --global "${CODEX_NPM_PACKAGE}"

WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN BUN_INSTALL_IGNORE_SCRIPTS=1 bun install --frozen-lockfile
RUN bun run build:web

COPY apps/server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV HOME=/codex-home
ENV CODEX_HOME=/codex-home
ENV T3CODE_HOME=/data/t3
ENV T3_WORKSPACE_CWD=/workspace/codex-remote
ENV T3CODE_PORT=8787

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
