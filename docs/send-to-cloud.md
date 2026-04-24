# Send To Cloud

`send-to-cloud` packages a local workspace and CloudCodex conversation into a V1 handoff continuation. It does not migrate raw Codex thread files.

## Handoff Format

The package is JSON with:

- `kind: "cloudcodex.handoff-package"`
- `manifest`: schema-validated metadata for source git state, bundle hash, approved overlay files, and conversation summary.
- `gitBundleBase64`: a safe git bundle of committed `HEAD`.
- `overlayFiles`: explicitly approved untracked regular files only.
- `handoffPrompt`: concise continuation prompt generated from the manifest and exported CloudCodex events.

Tracked dirty files are refused. Commit or stash them before handoff.

## Guardrails

Client, server, and cloud runner all validate the handoff independently.

- Denylisted paths include `.env`, SSH keys, AWS/GCloud/Kube configs, npm/pypi tokens, netrc files, private keys, certificates, and keychains.
- Overlay mode only supports explicitly approved untracked files.
- Secret scanning checks private key blocks, common API key/token assignments, OpenAI keys, GitHub tokens, and AWS access keys.
- Symlinks and path traversal are rejected.
- Server validates JSON schema, package hash, git bundle verification, overlay hashes, denylist, and secret scan before dispatching unpack.
- Runner downloads the package over authenticated HTTP, validates it again, verifies the git bundle, clones into `/workspaces/<project>`, applies overlays inside the project root, and then starts the handoff prompt through the existing runner protocol.

## Upload API

All routes require normal cloud-server authentication.

1. Initialize:

```http
POST /api/uploads/init
{
  "runnerId": "cloud-runner-vps",
  "projectId": "my-repo",
  "totalBytes": 12345,
  "sha256": "package-sha256",
  "manifest": {}
}
```

2. Upload sequential chunks:

```http
POST /api/uploads/<uploadId>/chunks
{
  "index": 0,
  "dataBase64": "...",
  "sha256": "chunk-sha256"
}
```

3. Complete:

```http
POST /api/uploads/<uploadId>/complete
{
  "sha256": "package-sha256"
}
```

The server validates the package and sends `runner.workspace.unpack` to the connected runner. After the runner responds with `runner.workspace.unpacked`, the server starts a new cloud Codex thread using the generated handoff prompt.

## Skill

The Codex skill is installed at:

```text
~/.codex/skills/send-to-cloud
```

The scripts are wrappers around `packages/workspace-packager/src/cli.ts`:

- `detect_env`
- `make_bundle`
- `redact_manifest`
- `send_to_cloud`

Use `CODEX_REMOTE_REPO=/path/to/codex-remote` if running the scripts outside this repo.
