import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ServerBridgedEnvironment,
} from "@t3tools/contracts";
import { Cause, Context, Effect, Layer, Queue, Stream } from "effect";

export interface LocalBridgeCommand {
  readonly requestId: string;
  readonly mode: "request" | "stream";
  readonly method: string;
  readonly payload: unknown;
}

export interface LocalBridgeRegisterInput {
  readonly environment: ExecutionEnvironmentDescriptor;
  readonly startedAt?: string | undefined;
}

export interface LocalBridgeResponseInput {
  readonly environmentId: EnvironmentId;
  readonly requestId: string;
  readonly ok: boolean;
  readonly value?: unknown | undefined;
  readonly error?: string | undefined;
}

export interface LocalBridgeStreamInput {
  readonly environmentId: EnvironmentId;
  readonly requestId: string;
  readonly kind: "item" | "end" | "error";
  readonly value?: unknown | undefined;
  readonly error?: string | undefined;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface PendingStream {
  readonly queue: Queue.Enqueue<unknown, Error | Cause.Done<void>>;
}

interface BridgeConnection {
  readonly environment: ExecutionEnvironmentDescriptor;
  readonly connectedAt: string;
  lastSeenAt: string;
  readonly commands: LocalBridgeCommand[];
  readonly pollWaiters: Array<(commands: LocalBridgeCommand[]) => void>;
  readonly pendingRequests: Map<string, PendingRequest>;
  readonly pendingStreams: Map<string, PendingStream>;
}

const STALE_BRIDGE_MS = 90_000;
const STALE_BRIDGE_SWEEP_MS = 15_000;

export interface LocalBridgeRegistryShape {
  readonly register: (input: LocalBridgeRegisterInput) => Effect.Effect<ServerBridgedEnvironment>;
  readonly poll: (input: {
    readonly environmentId: EnvironmentId;
    readonly timeoutMs: number;
  }) => Effect.Effect<ReadonlyArray<LocalBridgeCommand>>;
  readonly completeRequest: (input: LocalBridgeResponseInput) => Effect.Effect<boolean>;
  readonly publishStream: (input: LocalBridgeStreamInput) => Effect.Effect<boolean>;
  readonly list: Effect.Effect<ReadonlyArray<ServerBridgedEnvironment>>;
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerBridgedEnvironment>>;
  readonly request: (input: {
    readonly environmentId: EnvironmentId;
    readonly method: string;
    readonly payload: unknown;
    readonly timeoutMs?: number;
  }) => Effect.Effect<unknown, Error>;
  readonly stream: (input: {
    readonly environmentId: EnvironmentId;
    readonly method: string;
    readonly payload: unknown;
  }) => Stream.Stream<unknown, Error>;
  readonly readConnectedAt: (environmentId: EnvironmentId) => Effect.Effect<string | null>;
}

export class LocalBridgeRegistry extends Context.Service<
  LocalBridgeRegistry,
  LocalBridgeRegistryShape
>()("t3/bridge/LocalBridgeRegistry") {}

function nowIso(): string {
  return new Date().toISOString();
}

function makeRequestId(): string {
  return `bridge:${crypto.randomUUID()}`;
}

function normalizeLocalEnvironment(
  environment: ExecutionEnvironmentDescriptor,
): ExecutionEnvironmentDescriptor {
  return {
    ...environment,
    origin: "local",
  };
}

function toPublicBridge(connection: BridgeConnection): ServerBridgedEnvironment {
  return {
    environment: connection.environment,
    connectedAt: connection.connectedAt,
  };
}

function makeRegistry(): LocalBridgeRegistryShape {
  const bridges = new Map<EnvironmentId, BridgeConnection>();
  const changeSubscribers = new Set<Queue.Enqueue<ReadonlyArray<ServerBridgedEnvironment>>>();

  const listSnapshot = (): ReadonlyArray<ServerBridgedEnvironment> =>
    [...bridges.values()]
      .map(toPublicBridge)
      .toSorted((left, right) => left.environment.label.localeCompare(right.environment.label));

  const emitChange = () => {
    const snapshot = listSnapshot();
    for (const subscriber of changeSubscribers) {
      void Effect.runPromise(Queue.offer(subscriber, snapshot));
    }
  };

  const enqueue = (connection: BridgeConnection, command: LocalBridgeCommand) => {
    const waiter = connection.pollWaiters.shift();
    if (waiter) {
      waiter([command]);
      return;
    }
    connection.commands.push(command);
  };

  const getBridge = (environmentId: EnvironmentId): BridgeConnection | null =>
    bridges.get(environmentId) ?? null;

  const failConnection = (connection: BridgeConnection, message: string) => {
    for (const pending of connection.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    connection.pendingRequests.clear();
    for (const pending of connection.pendingStreams.values()) {
      void Effect.runPromise(Queue.fail(pending.queue, new Error(message)));
    }
    connection.pendingStreams.clear();
    for (const waiter of connection.pollWaiters.splice(0, connection.pollWaiters.length)) {
      waiter([]);
    }
  };

  const removeBridge = (environmentId: EnvironmentId, message: string, shouldEmit = true) => {
    const connection = bridges.get(environmentId);
    if (!connection) {
      return false;
    }
    bridges.delete(environmentId);
    failConnection(connection, message);
    if (shouldEmit) {
      emitChange();
    }
    return true;
  };

  const sweepStaleBridges = () => {
    const cutoff = Date.now() - STALE_BRIDGE_MS;
    let changed = false;
    for (const connection of bridges.values()) {
      if (Date.parse(connection.lastSeenAt) < cutoff) {
        changed =
          removeBridge(
            connection.environment.environmentId,
            "Local bridge stopped polling.",
            false,
          ) || changed;
      }
    }
    if (changed) {
      emitChange();
    }
  };

  const sweepTimer = setInterval(sweepStaleBridges, STALE_BRIDGE_SWEEP_MS);
  sweepTimer.unref?.();

  return {
    register: (input) =>
      Effect.sync(() => {
        const environment = normalizeLocalEnvironment(input.environment);
        const connectedAt = input.startedAt ?? nowIso();
        const existing = bridges.get(environment.environmentId);
        if (existing) {
          failConnection(existing, "Local bridge reconnected before the request completed.");
        }

        const connection: BridgeConnection = {
          environment,
          connectedAt,
          lastSeenAt: connectedAt,
          commands: [],
          pollWaiters: [],
          pendingRequests: new Map(),
          pendingStreams: new Map(),
        };
        bridges.set(environment.environmentId, connection);
        emitChange();
        return toPublicBridge(connection);
      }),

    poll: (input) =>
      Effect.promise(
        () =>
          new Promise<ReadonlyArray<LocalBridgeCommand>>((resolve) => {
            const bridge = getBridge(input.environmentId);
            if (!bridge) {
              resolve([]);
              return;
            }
            bridge.lastSeenAt = nowIso();
            if (bridge.commands.length > 0) {
              resolve(bridge.commands.splice(0, bridge.commands.length));
              return;
            }

            const waiter = (commands: LocalBridgeCommand[]) => {
              clearTimeout(timeout);
              resolve(commands);
            };
            const timeout = setTimeout(() => {
              const index = bridge.pollWaiters.indexOf(waiter);
              if (index >= 0) {
                bridge.pollWaiters.splice(index, 1);
              }
              resolve([]);
            }, input.timeoutMs);
            bridge.pollWaiters.push(waiter);
          }),
      ),

    completeRequest: (input) =>
      Effect.sync(() => {
        const bridge = getBridge(input.environmentId);
        const pending = bridge?.pendingRequests.get(input.requestId);
        if (!bridge || !pending) {
          return false;
        }
        bridge.pendingRequests.delete(input.requestId);
        clearTimeout(pending.timeout);
        if (input.ok) {
          pending.resolve(input.value);
        } else {
          pending.reject(new Error(input.error ?? "Local bridge request failed."));
        }
        return true;
      }),

    publishStream: (input) =>
      Effect.sync(() => {
        const bridge = getBridge(input.environmentId);
        const pending = bridge?.pendingStreams.get(input.requestId);
        if (!bridge || !pending) {
          return false;
        }

        switch (input.kind) {
          case "item":
            void Effect.runPromise(Queue.offer(pending.queue, input.value));
            return true;
          case "end":
            bridge.pendingStreams.delete(input.requestId);
            void Effect.runPromise(Queue.end(pending.queue));
            return true;
          case "error":
            bridge.pendingStreams.delete(input.requestId);
            void Effect.runPromise(
              Queue.fail(pending.queue, new Error(input.error ?? "Local bridge stream failed.")),
            );
            return true;
        }
      }),

    list: Effect.sync(listSnapshot),

    streamChanges: Stream.callback<ReadonlyArray<ServerBridgedEnvironment>>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          changeSubscribers.add(queue);
          void Effect.runPromise(Queue.offer(queue, listSnapshot()));
          return queue;
        }),
        (registeredQueue) =>
          Effect.sync(() => {
            changeSubscribers.delete(registeredQueue);
          }),
      ),
    ),

    request: (input) =>
      Effect.callback<unknown, Error>((resume) => {
        const bridge = getBridge(input.environmentId);
        if (!bridge) {
          resume(Effect.fail(new Error("Local bridge is not connected.")));
          return;
        }

        const requestId = makeRequestId();
        const timeout = setTimeout(() => {
          bridge.pendingRequests.delete(requestId);
          resume(Effect.fail(new Error("Local bridge request timed out.")));
        }, input.timeoutMs ?? 120_000);
        bridge.pendingRequests.set(requestId, {
          timeout,
          resolve: (value) => resume(Effect.succeed(value)),
          reject: (error) => resume(Effect.fail(error)),
        });
        enqueue(bridge, {
          requestId,
          mode: "request",
          method: input.method,
          payload: input.payload,
        });
      }),

    stream: (input) =>
      Stream.callback<unknown, Error>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const bridge = getBridge(input.environmentId);
            if (!bridge) {
              void Effect.runPromise(Queue.fail(queue, new Error("Local bridge is not connected.")));
              return null;
            }

            const requestId = makeRequestId();
            bridge.pendingStreams.set(requestId, { queue });
            enqueue(bridge, {
              requestId,
              mode: "stream",
              method: input.method,
              payload: input.payload,
            });
            return { bridge, requestId };
          }),
          (entry) =>
            Effect.sync(() => {
              if (entry) {
                entry.bridge.pendingStreams.delete(entry.requestId);
              }
            }),
        ),
      ),

    readConnectedAt: (environmentId) =>
      Effect.sync(() => getBridge(environmentId)?.connectedAt ?? null),
  };
}

export const LocalBridgeRegistryLive = Layer.succeed(LocalBridgeRegistry, makeRegistry());
