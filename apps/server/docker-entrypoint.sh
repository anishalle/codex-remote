#!/bin/sh
set -eu

T3CODE_HOME="${T3CODE_HOME:-/data/t3}"
T3_WORKSPACE_CWD="${T3_WORKSPACE_CWD:-/workspace/codex-remote}"
SETTINGS_PATH="${T3CODE_HOME}/userdata/settings.json"

mkdir -p "$T3CODE_HOME" "${HOME:-/codex-home}" "$T3_WORKSPACE_CWD" "$(dirname "$SETTINGS_PATH")"

if [ ! -f "$SETTINGS_PATH" ]; then
  cat >"$SETTINGS_PATH" <<'JSON'
{
  "providers": {
    "codex": {
      "enabled": true,
      "homePath": "/codex-home"
    },
    "claudeAgent": {
      "enabled": false
    },
    "cursor": {
      "enabled": false
    },
    "opencode": {
      "enabled": false
    }
  }
}
JSON
fi

bun apps/server/src/bin.ts project add --base-dir "$T3CODE_HOME" "$T3_WORKSPACE_CWD" >/tmp/t3-project-init.log 2>&1 || true

exec bun apps/server/src/bin.ts serve --base-dir "$T3CODE_HOME" --mode web --host 0.0.0.0 --port "${T3CODE_PORT:-8787}" "$T3_WORKSPACE_CWD"
