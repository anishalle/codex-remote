import { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { respondToAuthError } from "../auth/http.ts";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { LocalBridgeRegistry } from "./LocalBridgeRegistry.ts";

const BridgeRegisterInput = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
});

const BridgePollInput = Schema.Struct({
  environmentId: EnvironmentId,
});

const BridgeResponseInput = Schema.Struct({
  environmentId: EnvironmentId,
  requestId: Schema.String,
  ok: Schema.Boolean,
  value: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});

const BridgeStreamInput = Schema.Struct({
  environmentId: EnvironmentId,
  requestId: Schema.String,
  kind: Schema.Literals(["item", "end", "error"]),
  value: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});

const POLL_TIMEOUT_MS = 25_000;

const requireBridgeSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(request);
});

const invalidBridgePayload = (cause: unknown) =>
  new AuthError({
    message: "Invalid local bridge payload.",
    status: 400,
    cause,
  });

export const localBridgeRegisterRouteLayer = HttpRouter.add(
  "POST",
  "/api/local-bridge/register",
  Effect.gen(function* () {
    yield* requireBridgeSession;
    const input = yield* HttpServerRequest.schemaBodyJson(BridgeRegisterInput).pipe(
      Effect.mapError(invalidBridgePayload),
    );
    const registry = yield* LocalBridgeRegistry;
    const bridge = yield* registry.register(input);
    return HttpServerResponse.jsonUnsafe({ bridge }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const localBridgePollRouteLayer = HttpRouter.add(
  "POST",
  "/api/local-bridge/poll",
  Effect.gen(function* () {
    yield* requireBridgeSession;
    const input = yield* HttpServerRequest.schemaBodyJson(BridgePollInput).pipe(
      Effect.mapError(invalidBridgePayload),
    );
    const registry = yield* LocalBridgeRegistry;
    const commands = yield* registry.poll({
      environmentId: input.environmentId,
      timeoutMs: POLL_TIMEOUT_MS,
    });
    return HttpServerResponse.jsonUnsafe({ commands }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const localBridgeResponseRouteLayer = HttpRouter.add(
  "POST",
  "/api/local-bridge/respond",
  Effect.gen(function* () {
    yield* requireBridgeSession;
    const input = yield* HttpServerRequest.schemaBodyJson(BridgeResponseInput).pipe(
      Effect.mapError(invalidBridgePayload),
    );
    const registry = yield* LocalBridgeRegistry;
    const accepted = yield* registry.completeRequest(input);
    return HttpServerResponse.jsonUnsafe({ accepted }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const localBridgeStreamRouteLayer = HttpRouter.add(
  "POST",
  "/api/local-bridge/stream",
  Effect.gen(function* () {
    yield* requireBridgeSession;
    const input = yield* HttpServerRequest.schemaBodyJson(BridgeStreamInput).pipe(
      Effect.mapError(invalidBridgePayload),
    );
    const registry = yield* LocalBridgeRegistry;
    const accepted = yield* registry.publishStream(input);
    return HttpServerResponse.jsonUnsafe({ accepted }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);
