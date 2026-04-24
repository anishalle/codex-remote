# Docker Cloud Runner

`apps/cloud-runner` is the Docker-first runner for fully remote Codex sessions. It uses the same authenticated runner WebSocket as the Mac runner, opens no inbound ports, and keeps `codex app-server` private inside the container.

## Container Boundary

The container has three writable mounts:

- `/workspaces`: cloud project directories. A project is exactly one direct child directory, for example `/workspaces/my-repo`.
- `/codex-home`: Codex CLI home and login state. This is where `codex login` writes credentials.
- `/cloudcodex`: runner state, including `state.db` and the paired runner session token.

The image runs as UID/GID `10001`, drops Linux capabilities in the compose example, sets `no-new-privileges`, uses a read-only root filesystem, and does not mount `/var/run/docker.sock`.

Path rules are intentionally strict:

- Project ids may contain only letters, numbers, dot, underscore, and dash.
- Project ids may not contain `..`, slashes, absolute paths, or hidden leading-dot names.
- The runner resolves symlinks and rejects any project or file path that escapes `/workspaces`.
- The server validates project creation requests first, and the runner re-checks before creating or using paths.

Codex turns run with `CLOUD_CODEX_CODEX_SANDBOX=workspace-write` by default so the agent can edit and test the registered project. The bridge sends a full sandbox policy with writes constrained to the selected project root, read access restricted to platform defaults plus that project root, and network access disabled unless `CLOUD_CODEX_NETWORK_ACCESS=1` is explicitly set. Use `CLOUD_CODEX_CODEX_SANDBOX=read-only` for an inspect-only runner.

## Build

```bash
docker compose -f apps/cloud-runner/docker-compose.example.yml build
```

The Dockerfile installs the Codex CLI package but does not bake any credentials, server URLs, pairing tokens, session tokens, SSH keys, or cloud credentials into the image.

## Pair Runner

Create a runner pairing token from the cloud-server, then pair inside the persistent runner-state volume:

```bash
CLOUD_CODEX_SERVER_URL=https://codex.example.com \
docker compose -f apps/cloud-runner/docker-compose.example.yml run --rm cloud-runner \
  pair ccp_REDACTED --name "VPS cloud runner"
```

The token is written to `/cloudcodex/session.token` inside the named volume. Do not put the raw session token in the image or commit it into compose files.

## Codex Login

Run Codex login in a setup container or an interactive runner shell so credentials land in the mounted `/codex-home` volume:

```bash
docker compose -f apps/cloud-runner/docker-compose.example.yml run --rm \
  --entrypoint codex cloud-runner login
```

For debugging:

```bash
docker compose -f apps/cloud-runner/docker-compose.example.yml run --rm \
  --entrypoint sh cloud-runner
codex login
```

## Cloud Projects

Create a workspace locally in the cloud-runner volume:

```bash
docker compose -f apps/cloud-runner/docker-compose.example.yml run --rm cloud-runner \
  project create my-repo
```

You can also create a cloud project through the cloud-server API while the runner is connected:

```bash
curl -X POST https://codex.example.com/api/cloud-projects \
  -H "Authorization: Bearer $CLIENT_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"runnerId":"cloud-runner-vps","projectId":"my-repo"}'
```

After the runner registers the project, start a cloud thread with the existing turn API:

```bash
curl -X POST https://codex.example.com/api/turns/start \
  -H "Authorization: Bearer $CLIENT_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"runnerId":"cloud-runner-vps","projectId":"my-repo","prompt":"inspect this workspace"}'
```

Runtime events, command output, file diffs, errors, and approval requests stream back through the append-only event store. Approval decisions sent from the web UI are forwarded to the runner and resolved inside the private Codex app-server process.

## Handoff Uploads

`send-to-cloud` uploads a schema-validated handoff package to `apps/cloud-server`. The cloud-server validates the package and sends `runner.workspace.unpack` to this runner. The runner downloads the package over authenticated HTTP, validates it again, verifies the git bundle, clones it into `/workspaces/<project>`, applies approved untracked overlay files, registers the cloud project, and lets the server start the generated handoff prompt as a new cloud Codex thread.

The runner never accepts raw workspace paths from the client and never exposes an upload or Codex app-server port.

## Run

```bash
CLOUD_CODEX_SERVER_URL=https://codex.example.com \
docker compose -f apps/cloud-runner/docker-compose.example.yml up -d
```

The compose example intentionally publishes no ports. The runner connects outbound to the authenticated cloud-server only.

## Homelab And NGINX Safeguards

For `anishalle.com`, keep the public surface to the cloud-server behind NGINX or Cloudflare Access. Do not expose `apps/cloud-runner`, raw Codex app-server, or any unauthenticated WebSocket endpoint.

NGINX should proxy only the cloud-server port and include WebSocket upgrade headers. Keep Certbot-managed SSL and redirect blocks out of hand-written config files. A hand-written server block should contain only the reverse proxy section, matching the homelab workflow in `/etc/nginx/conf.d/<subdomain>.anishalle.com.conf`.

Before choosing or binding a host port, inspect existing Docker Compose projects and bound ports on the server. If NGINX cannot reach a Docker backend on SELinux, check `httpd_can_network_connect` before changing file labels:

```bash
sudo getsebool httpd_can_network_connect
sudo setsebool -P httpd_can_network_connect 1
```

Do not add a `ports:` block to the cloud-runner service and do not mount the host Docker socket.
