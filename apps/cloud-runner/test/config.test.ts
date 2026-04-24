import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCloudRunnerServerUrl } from "../src/config.ts";

test("cloud runner requires opt-in for non-local plain HTTP", () => {
  assert.throws(
    () => normalizeCloudRunnerServerUrl("http://cloud-server:8787"),
    /CLOUD_CODEX_ALLOW_INSECURE_HTTP=1/,
  );

  assert.equal(
    normalizeCloudRunnerServerUrl("http://cloud-server:8787", { allowInsecureHttp: true }),
    "http://cloud-server:8787",
  );
});
