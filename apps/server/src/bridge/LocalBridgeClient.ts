import {
  type AuthSessionId,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  WsRpcGroup,
} from "@t3tools/contracts";
import { Context, Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { RpcTest } from "effect/unstable/rpc";

import type { LocalBridgeCommand } from "./LocalBridgeRegistry.ts";
import { makeWsRpcLayer } from "../ws.ts";

interface LocalBridgeClientInput {
  readonly publicHttpBaseUrl: string;
  readonly publicBearerToken: string;
  readonly localSessionId: AuthSessionId;
  readonly environment: ExecutionEnvironmentDescriptor;
  readonly startedAt: string;
}

interface BridgePollResponse {
  readonly commands: ReadonlyArray<LocalBridgeCommand>;
}

const makeWsRpcClient = RpcTest.makeClient(WsRpcGroup);
type WsRpcClient = typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any>
  ? Client
  : never;
type RpcRequestMap = Record<string, (payload: unknown) => Effect.Effect<unknown, Error>>;
type RpcStreamMap = Record<string, (payload: unknown) => Stream.Stream<unknown, Error>>;

function bridgeEndpointUrl(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function postJson<T>(input: {
  readonly baseUrl: string;
  readonly token?: string;
  readonly pathname: string;
  readonly body: unknown;
}): Promise<T> {
  const response = await fetch(bridgeEndpointUrl(input.baseUrl, input.pathname), {
    method: "POST",
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(input.body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Bridge endpoint ${input.pathname} failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

function formatBridgeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

class LocalNodeRpcClient {
  private readonly runtime: ManagedRuntime.ManagedRuntime<never, never>;
  private readonly scope: Scope.Closeable;
  private readonly client: Promise<WsRpcClient>;

  constructor(localSessionId: AuthSessionId, context: Context.Context<unknown>) {
    this.runtime = ManagedRuntime.make(Layer.succeedContext(context));
    this.scope = this.runtime.runSync(Scope.make());
    this.client = this.runtime.runPromise(
      Scope.provide(this.scope)(makeWsRpcClient.pipe(Effect.provide(makeWsRpcLayer(localSessionId)))),
    );
  }

  async request(method: string, payload: unknown): Promise<unknown> {
    const client = await this.client;
    const fn = (client as unknown as RpcRequestMap)[method];
    if (!fn) {
      throw new Error(`Unsupported local RPC method: ${method}`);
    }
    return this.runtime.runPromise(fn(payload));
  }

  async stream(
    method: string,
    payload: unknown,
    onItem: (value: unknown) => Promise<void>,
  ): Promise<void> {
    const client = await this.client;
    const fn = (client as unknown as RpcStreamMap)[method];
    if (!fn) {
      throw new Error(`Unsupported local RPC stream method: ${method}`);
    }
    await this.runtime.runPromise(
      Stream.runForEach(fn(payload), (value) => Effect.promise(() => onItem(value))),
    );
  }

  async close(): Promise<void> {
    await this.runtime.runPromise(Scope.close(this.scope, Exit.void)).finally(() => {
      this.runtime.dispose();
    });
  }
}

async function respond(input: {
  readonly bridge: LocalBridgeClientInput;
  readonly environmentId: EnvironmentId;
  readonly requestId: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}): Promise<void> {
  await postJson({
    baseUrl: input.bridge.publicHttpBaseUrl,
    token: input.bridge.publicBearerToken,
    pathname: "/api/local-bridge/respond",
    body: {
      environmentId: input.environmentId,
      requestId: input.requestId,
      ok: input.ok,
      ...(input.ok ? { value: input.value } : { error: input.error ?? "Local bridge failed." }),
    },
  });
}

async function publishStream(input: {
  readonly bridge: LocalBridgeClientInput;
  readonly environmentId: EnvironmentId;
  readonly requestId: string;
  readonly kind: "item" | "end" | "error";
  readonly value?: unknown;
  readonly error?: string;
}): Promise<void> {
  await postJson({
    baseUrl: input.bridge.publicHttpBaseUrl,
    token: input.bridge.publicBearerToken,
    pathname: "/api/local-bridge/stream",
    body: {
      environmentId: input.environmentId,
      requestId: input.requestId,
      kind: input.kind,
      ...(input.kind === "item" ? { value: input.value } : {}),
      ...(input.kind === "error" ? { error: input.error ?? "Local bridge stream failed." } : {}),
    },
  });
}

async function handleCommand(input: {
  readonly bridge: LocalBridgeClientInput;
  readonly rpc: LocalNodeRpcClient;
  readonly command: LocalBridgeCommand;
}): Promise<void> {
  const environmentId = input.bridge.environment.environmentId;
  if (input.command.mode === "request") {
    try {
      const value = await input.rpc.request(input.command.method, input.command.payload);
      await respond({
        bridge: input.bridge,
        environmentId,
        requestId: input.command.requestId,
        ok: true,
        value,
      });
    } catch (error) {
      await respond({
        bridge: input.bridge,
        environmentId,
        requestId: input.command.requestId,
        ok: false,
        error: formatBridgeError(error),
      });
    }
    return;
  }

  try {
    await input.rpc.stream(input.command.method, input.command.payload, (value) =>
      publishStream({
        bridge: input.bridge,
        environmentId,
        requestId: input.command.requestId,
        kind: "item",
        value,
      }),
    );
    await publishStream({
      bridge: input.bridge,
      environmentId,
      requestId: input.command.requestId,
      kind: "end",
    });
  } catch (error) {
    await publishStream({
      bridge: input.bridge,
      environmentId,
      requestId: input.command.requestId,
      kind: "error",
      error: formatBridgeError(error),
    });
  }
}

async function runBridgeLoop(input: LocalBridgeClientInput, rpc: LocalNodeRpcClient): Promise<void> {
  for (;;) {
    await postJson({
      baseUrl: input.publicHttpBaseUrl,
      token: input.publicBearerToken,
      pathname: "/api/local-bridge/register",
      body: {
        environment: {
          ...input.environment,
          origin: "local",
        },
        startedAt: input.startedAt,
      },
    });

    for (;;) {
      const response = await postJson<BridgePollResponse>({
        baseUrl: input.publicHttpBaseUrl,
        token: input.publicBearerToken,
        pathname: "/api/local-bridge/poll",
        body: {
          environmentId: input.environment.environmentId,
        },
      });
      for (const command of response.commands) {
        void handleCommand({
          bridge: input,
          rpc,
          command,
        }).catch((error) => {
          console.warn("Local bridge command failed", {
            error: formatBridgeError(error),
          });
        });
      }
    }
  }
}

export function runLocalBridgeClient(input: LocalBridgeClientInput): Effect.Effect<never> {
  return Effect.gen(function* () {
    yield* Effect.logInfo("Starting local bridge client", {
      publicHttpBaseUrl: input.publicHttpBaseUrl,
      environmentId: input.environment.environmentId,
    });
    const runtimeContext = Context.omit(Scope.Scope)(yield* Effect.context<never>());
    return yield* Effect.promise<never>(async () => {
      const rpc = new LocalNodeRpcClient(input.localSessionId, runtimeContext);
      try {
        for (;;) {
          try {
            await runBridgeLoop(input, rpc);
          } catch (error) {
            console.warn("Local bridge client stopped", {
              error: formatBridgeError(error),
            });
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
        }
      } finally {
        await rpc.close();
      }
    });
  });
}

export async function bootstrapPublicBridgeBearerSession(input: {
  readonly publicHttpBaseUrl: string;
  readonly pairingToken: string;
}): Promise<string> {
  const result = await postJson<{ readonly sessionToken: string }>({
    baseUrl: input.publicHttpBaseUrl,
    pathname: "/api/auth/bootstrap/bearer",
    body: {
      credential: input.pairingToken,
    },
  });
  return result.sessionToken;
}
