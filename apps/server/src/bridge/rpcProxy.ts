import {
  FilesystemBrowseError,
  GitCommandError,
  GitManagerError,
  KeybindingsConfigError,
  OpenError,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationReplayEventsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ServerSettingsError,
  TerminalHistoryError,
  WS_METHODS,
  WsRpcGroup,
  type EnvironmentId,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadShell,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
} from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";

import { LocalBridgeRegistry } from "./LocalBridgeRegistry.ts";

type ErrorFactory = (message: string, cause: unknown) => Error;

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const LONG_REQUEST_TIMEOUT_MS = 10 * 60_000;

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "Local bridge request failed.";
}

function wrap(factory: ErrorFactory, cause: unknown): Error {
  return factory(errorMessage(cause), cause);
}

function genericError(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}

function keybindingsError(message: string, cause: unknown): KeybindingsConfigError {
  return new KeybindingsConfigError({
    configPath: "local bridge",
    detail: message,
    cause,
  });
}

function settingsError(message: string, cause: unknown): ServerSettingsError {
  return new ServerSettingsError({
    settingsPath: "local bridge",
    detail: message,
    cause,
  });
}

function gitManagerError(message: string, cause: unknown): GitManagerError {
  return new GitManagerError({
    operation: "local bridge",
    detail: message,
    cause,
  });
}

function gitCommandError(message: string, cause: unknown): GitCommandError {
  return new GitCommandError({
    operation: "local bridge",
    command: "remote",
    cwd: "unknown",
    detail: message,
    cause,
  });
}

function terminalError(message: string, cause: unknown): TerminalHistoryError {
  return new TerminalHistoryError({
    operation: "read",
    threadId: "local-bridge",
    terminalId: "local-bridge",
    cause: new Error(message, { cause }),
  });
}

function localizeServerConfig(config: ServerConfig): ServerConfig {
  return {
    ...config,
    environment: {
      ...config.environment,
      origin: "local",
    },
    bridgedEnvironments: [],
  };
}

function localizeServerConfigEvent(event: ServerConfigStreamEvent): ServerConfigStreamEvent {
  if (event.type === "snapshot") {
    return {
      ...event,
      config: localizeServerConfig(event.config),
    };
  }
  if (event.type === "bridgedEnvironmentsUpdated") {
    return {
      ...event,
      payload: {
        bridgedEnvironments: [],
      },
    };
  }
  return event;
}

function localizeLifecycleEvent(event: ServerLifecycleStreamEvent): ServerLifecycleStreamEvent {
  if (event.type === "welcome") {
    return {
      ...event,
      payload: {
        ...event.payload,
        environment: {
          ...event.payload.environment,
          origin: "local",
        },
      },
    };
  }
  if (event.type === "ready") {
    return {
      ...event,
      payload: {
        ...event.payload,
        environment: {
          ...event.payload.environment,
          origin: "local",
        },
      },
    };
  }
  return event;
}

function isActiveAtBridgeStart(thread: OrchestrationThreadShell): boolean {
  const status = thread.session?.status;
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan ||
    thread.latestTurn?.state === "running" ||
    Boolean(status && status !== "idle" && status !== "stopped")
  );
}

function isThreadVisible(thread: OrchestrationThreadShell, connectedAt: string): boolean {
  return (
    thread.createdAt >= connectedAt ||
    thread.updatedAt >= connectedAt ||
    isActiveAtBridgeStart(thread)
  );
}

function filterShellItem(
  item: OrchestrationShellStreamItem,
  connectedAt: string | null,
): OrchestrationShellStreamItem | null {
  if (!connectedAt) {
    return item;
  }

  if (item.kind === "snapshot") {
    return {
      kind: "snapshot",
      snapshot: {
        ...item.snapshot,
        threads: item.snapshot.threads.filter((thread) => isThreadVisible(thread, connectedAt)),
      },
    };
  }

  if (item.kind === "thread-upserted" && !isThreadVisible(item.thread, connectedAt)) {
    return null;
  }

  return item;
}

export const makeBridgeWsRpcLayer = (environmentId: EnvironmentId) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const registry = yield* LocalBridgeRegistry;
      const connectedAt = yield* registry.readConnectedAt(environmentId);

      const request = <A>(
        method: string,
        payload: unknown,
        errorFactory: ErrorFactory,
        timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      ): Effect.Effect<A, Error> =>
        registry
          .request({
            environmentId,
            method,
            payload,
            timeoutMs,
          })
          .pipe(
            Effect.map((value) => value as A),
            Effect.mapError((cause) => wrap(errorFactory, cause)),
          );

      const stream = <A>(
        method: string,
        payload: unknown,
        errorFactory: ErrorFactory,
      ): Stream.Stream<A, Error> =>
        registry.stream({ environmentId, method, payload }).pipe(
          Stream.map((value) => value as A),
          Stream.mapError((cause) => wrap(errorFactory, cause)),
        );

      return {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (payload: unknown) =>
          request(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            payload,
            (message, cause) => new OrchestrationDispatchCommandError({ message, cause }),
            LONG_REQUEST_TIMEOUT_MS,
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (payload: unknown) =>
          request(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            payload,
            (message, cause) => new OrchestrationGetTurnDiffError({ message, cause }),
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (payload: unknown) =>
          request(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            payload,
            (message, cause) => new OrchestrationGetFullThreadDiffError({ message, cause }),
          ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (payload: unknown) =>
          request(
            ORCHESTRATION_WS_METHODS.replayEvents,
            payload,
            (message, cause) => new OrchestrationReplayEventsError({ message, cause }),
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (payload: unknown) =>
          stream<OrchestrationShellStreamItem>(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            payload,
            (message, cause) => new OrchestrationGetSnapshotError({ message, cause }),
          ).pipe(
            Stream.map((item) => filterShellItem(item, connectedAt)),
            Stream.filter((item): item is OrchestrationShellStreamItem => item !== null),
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (payload: unknown) =>
          stream(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            payload,
            (message, cause) => new OrchestrationGetSnapshotError({ message, cause }),
          ),

        [WS_METHODS.serverGetConfig]: (payload: unknown) =>
          request<ServerConfig>(
            WS_METHODS.serverGetConfig,
            payload,
            keybindingsError,
          ).pipe(Effect.map(localizeServerConfig)),
        [WS_METHODS.serverRefreshProviders]: (payload: unknown) =>
          request(WS_METHODS.serverRefreshProviders, payload, genericError),
        [WS_METHODS.serverUpsertKeybinding]: (payload: unknown) =>
          request(
            WS_METHODS.serverUpsertKeybinding,
            payload,
            keybindingsError,
          ),
        [WS_METHODS.serverGetSettings]: (payload: unknown) =>
          request(WS_METHODS.serverGetSettings, payload, settingsError),
        [WS_METHODS.serverUpdateSettings]: (payload: unknown) =>
          request(WS_METHODS.serverUpdateSettings, payload, settingsError),
        [WS_METHODS.subscribeServerConfig]: (payload: unknown) =>
          stream<ServerConfigStreamEvent>(
            WS_METHODS.subscribeServerConfig,
            payload,
            keybindingsError,
          ).pipe(Stream.map(localizeServerConfigEvent)),
        [WS_METHODS.subscribeServerLifecycle]: (payload: unknown) =>
          stream<ServerLifecycleStreamEvent>(
            WS_METHODS.subscribeServerLifecycle,
            payload,
            genericError,
          ).pipe(Stream.map(localizeLifecycleEvent)),
        [WS_METHODS.subscribeAuthAccess]: (payload: unknown) =>
          stream(WS_METHODS.subscribeAuthAccess, payload, genericError),

        [WS_METHODS.projectsSearchEntries]: (payload: unknown) =>
          request(
            WS_METHODS.projectsSearchEntries,
            payload,
            (message, cause) => new ProjectSearchEntriesError({ message, cause }),
          ),
        [WS_METHODS.projectsWriteFile]: (payload: unknown) =>
          request(
            WS_METHODS.projectsWriteFile,
            payload,
            (message, cause) => new ProjectWriteFileError({ message, cause }),
          ),
        [WS_METHODS.shellOpenInEditor]: (payload: unknown) =>
          request(
            WS_METHODS.shellOpenInEditor,
            payload,
            (message, cause) => new OpenError({ message, cause }),
          ),
        [WS_METHODS.filesystemBrowse]: (payload: unknown) =>
          request(
            WS_METHODS.filesystemBrowse,
            payload,
            (message, cause) => new FilesystemBrowseError({ message, cause }),
          ),

        [WS_METHODS.subscribeGitStatus]: (payload: unknown) =>
          stream(
            WS_METHODS.subscribeGitStatus,
            payload,
            gitManagerError,
          ),
        [WS_METHODS.gitRefreshStatus]: (payload: unknown) =>
          request(WS_METHODS.gitRefreshStatus, payload, gitManagerError),
        [WS_METHODS.gitPull]: (payload: unknown) =>
          request(
            WS_METHODS.gitPull,
            payload,
            gitCommandError,
            LONG_REQUEST_TIMEOUT_MS,
          ),
        [WS_METHODS.gitRunStackedAction]: (payload: unknown) =>
          stream(
            WS_METHODS.gitRunStackedAction,
            payload,
            gitManagerError,
          ),
        [WS_METHODS.gitResolvePullRequest]: (payload: unknown) =>
          request(WS_METHODS.gitResolvePullRequest, payload, gitManagerError),
        [WS_METHODS.gitPreparePullRequestThread]: (payload: unknown) =>
          request(
            WS_METHODS.gitPreparePullRequestThread,
            payload,
            gitManagerError,
            LONG_REQUEST_TIMEOUT_MS,
          ),
        [WS_METHODS.gitListBranches]: (payload: unknown) =>
          request(WS_METHODS.gitListBranches, payload, gitCommandError),
        [WS_METHODS.gitCreateWorktree]: (payload: unknown) =>
          request(
            WS_METHODS.gitCreateWorktree,
            payload,
            gitCommandError,
            LONG_REQUEST_TIMEOUT_MS,
          ),
        [WS_METHODS.gitRemoveWorktree]: (payload: unknown) =>
          request(
            WS_METHODS.gitRemoveWorktree,
            payload,
            gitCommandError,
            LONG_REQUEST_TIMEOUT_MS,
          ),
        [WS_METHODS.gitCreateBranch]: (payload: unknown) =>
          request(WS_METHODS.gitCreateBranch, payload, gitCommandError),
        [WS_METHODS.gitCheckout]: (payload: unknown) =>
          request(WS_METHODS.gitCheckout, payload, gitCommandError),
        [WS_METHODS.gitInit]: (payload: unknown) =>
          request(WS_METHODS.gitInit, payload, gitCommandError),

        [WS_METHODS.terminalOpen]: (payload: unknown) =>
          request(WS_METHODS.terminalOpen, payload, terminalError),
        [WS_METHODS.terminalWrite]: (payload: unknown) =>
          request(WS_METHODS.terminalWrite, payload, terminalError),
        [WS_METHODS.terminalResize]: (payload: unknown) =>
          request(WS_METHODS.terminalResize, payload, terminalError),
        [WS_METHODS.terminalClear]: (payload: unknown) =>
          request(WS_METHODS.terminalClear, payload, terminalError),
        [WS_METHODS.terminalRestart]: (payload: unknown) =>
          request(WS_METHODS.terminalRestart, payload, terminalError),
        [WS_METHODS.terminalClose]: (payload: unknown) =>
          request(WS_METHODS.terminalClose, payload, terminalError),
        [WS_METHODS.subscribeTerminalEvents]: (payload: unknown) =>
          stream(WS_METHODS.subscribeTerminalEvents, payload, terminalError),
      } as never;
    }),
  );
