import { Data, Effect, FileSystem, Layer, Path } from "effect";

import { AuthControlPlane } from "../auth/Services/AuthControlPlane.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { bootstrapPublicBridgeBearerSession, runLocalBridgeClient } from "./LocalBridgeClient.ts";
import { LOCAL_BRIDGE_SERVER_STARTED_AT } from "./localBridgeTiming.ts";

class LocalBridgeBootstrapError extends Data.TaggedError("LocalBridgeBootstrapError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const resolveBridgeBearerToken = Effect.fn("resolveBridgeBearerToken")(function* () {
  const config = yield* ServerConfig;
  const bridge = config.localBridge;
  if (!bridge) {
    return null;
  }

  if (bridge.bearerToken && bridge.bearerToken.trim().length > 0) {
    return bridge.bearerToken.trim();
  }

  const fs = yield* FileSystem.FileSystem;
  if (bridge.tokenFile) {
    const exists = yield* fs.exists(bridge.tokenFile).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      const token = (yield* fs.readFileString(bridge.tokenFile)).trim();
      if (token.length > 0) {
        return token;
      }
    }
  }

  if (!bridge.pairingToken || bridge.pairingToken.trim().length === 0) {
    return null;
  }

  const token = yield* Effect.tryPromise({
    try: () =>
      bootstrapPublicBridgeBearerSession({
        publicHttpBaseUrl: bridge.publicHttpBaseUrl,
        pairingToken: bridge.pairingToken!.trim(),
      }),
    catch: (cause) =>
      new LocalBridgeBootstrapError({
        message: "Bridge bearer bootstrap failed.",
        cause,
      }),
  });

  if (bridge.tokenFile) {
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(bridge.tokenFile), { recursive: true });
    yield* fs.writeFileString(bridge.tokenFile, `${token}\n`);
  }

  return token;
});

export const LocalBridgeClientLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const bridge = config.localBridge;
    if (!bridge) {
      return;
    }

    const bearerToken = yield* resolveBridgeBearerToken();
    if (!bearerToken) {
      yield* Effect.logWarning(
        "Local bridge is configured without a bearer token, token file, or pairing token.",
      );
      return;
    }

    const authControlPlane = yield* AuthControlPlane;
    const serverEnvironment = yield* ServerEnvironment;
    const issuedSession = yield* authControlPlane.issueSession({
      role: "owner",
      subject: "local-bridge-internal",
      label: "Local bridge internal",
    });
    const environment = yield* serverEnvironment.getDescriptor;

    yield* runLocalBridgeClient({
      publicHttpBaseUrl: bridge.publicHttpBaseUrl,
      publicBearerToken: bearerToken,
      localSessionId: issuedSession.sessionId,
      environment,
      startedAt: LOCAL_BRIDGE_SERVER_STARTED_AT,
    }).pipe(Effect.forkDetach);
  }),
);
