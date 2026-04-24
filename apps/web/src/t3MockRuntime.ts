import {
  type AuthAccessStreamEvent,
  type AuthClientSession,
  type AuthPairingLink,
  type AuthPairingCredentialResult,
  type AuthSessionState,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type GitStatusResult,
  type MessageId,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type ProjectId,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  type ThreadId,
} from "@t3tools/contracts";
import { DateTime } from "effect";

import type { WsRpcClient } from "./rpc/wsRpcClient";

export const T3_MOCK_UI_ENABLED = import.meta.env.VITE_T3_MOCK_UI !== "false";

export const MOCK_ENVIRONMENT_ID = EnvironmentId.make("codex-remote");
export const MOCK_PROJECT_ID = "project-codex-remote" as ProjectId;
export const MOCK_THREAD_ID = "thread-simple-greeting" as ThreadId;

const NOW_ISO = "2026-04-24T04:16:04.000Z";

function makeUtc(value: string) {
  return DateTime.makeUnsafe(Date.parse(value));
}

function buildMockClientSessions(): AuthClientSession[] {
  return [
    {
      sessionId: "session-owner-current" as never,
      subject: "browser-owner",
      role: "owner",
      method: "browser-session-cookie",
      client: {
        label: "Chrome on Mac",
        deviceType: "desktop",
        os: "macOS",
        browser: "Chrome",
        ipAddress: "127.0.0.1",
      },
      issuedAt: makeUtc("2026-04-24T03:55:00.000Z"),
      expiresAt: makeUtc("2026-05-24T03:55:00.000Z"),
      lastConnectedAt: makeUtc("2026-04-24T04:16:04.000Z"),
      connected: true,
      current: true,
    },
  ];
}

let mockPairingLinks: AuthPairingLink[] = [];
let mockClientSessions: AuthClientSession[] = buildMockClientSessions();
let mockAuthAccessRevision = 1;
const mockAuthAccessListeners = new Set<(event: AuthAccessStreamEvent) => void>();

function emitMockAuthAccess(event: AuthAccessStreamEvent) {
  for (const listener of mockAuthAccessListeners) {
    listener(event);
  }
}

function nextMockAuthAccessRevision() {
  mockAuthAccessRevision += 1;
  return mockAuthAccessRevision;
}

export function resetMockAuthAccessState() {
  mockPairingLinks = [];
  mockClientSessions = buildMockClientSessions();
  mockAuthAccessRevision = 1;
}

export function getMockAuthSessionState(): AuthSessionState {
  return {
    authenticated: true,
    auth: getMockServerConfig().auth,
    role: "owner",
    sessionMethod: "browser-session-cookie",
    expiresAt: makeUtc("2026-05-24T03:55:00.000Z"),
  };
}

export function subscribeMockAuthAccess(
  listener: (event: AuthAccessStreamEvent) => void,
): () => void {
  mockAuthAccessListeners.add(listener);
  queueMicrotask(() =>
    listener({
      version: 1,
      revision: mockAuthAccessRevision,
      type: "snapshot",
      payload: {
        pairingLinks: [...mockPairingLinks],
        clientSessions: [...mockClientSessions],
      },
    }),
  );
  return () => {
    mockAuthAccessListeners.delete(listener);
  };
}

export function getMockAuthAccessSnapshot(): {
  pairingLinks: AuthPairingLink[];
  clientSessions: AuthClientSession[];
} {
  return {
    pairingLinks: [...mockPairingLinks],
    clientSessions: [...mockClientSessions],
  };
}

export function createMockPairingCredential(label?: string): AuthPairingCredentialResult {
  const createdAt = makeUtc(NOW_ISO);
  const expiresAt = makeUtc("2026-04-25T04:16:04.000Z");
  const result: AuthPairingCredentialResult = {
    id: `pairing-link-${mockPairingLinks.length + 1}`,
    credential: `pairing-token-${mockPairingLinks.length + 1}`,
    ...(label && label.trim().length > 0 ? { label: label.trim() } : {}),
    expiresAt,
  };
  const pairingLink = {
    id: result.id,
    credential: result.credential,
    role: "client" as const,
    subject: "shared-link",
    ...(result.label ? { label: result.label } : {}),
    createdAt,
    expiresAt,
  };
  mockPairingLinks = [pairingLink, ...mockPairingLinks];
  emitMockAuthAccess({
    version: 1,
    revision: nextMockAuthAccessRevision(),
    type: "pairingLinkUpserted",
    payload: pairingLink,
  });
  return result;
}

export function revokeMockPairingCredential(id: string): void {
  mockPairingLinks = mockPairingLinks.filter((pairingLink) => pairingLink.id !== id);
  emitMockAuthAccess({
    version: 1,
    revision: nextMockAuthAccessRevision(),
    type: "pairingLinkRemoved",
    payload: { id },
  });
}

export function revokeMockClientSession(sessionId: string): void {
  mockClientSessions = mockClientSessions.filter(
    (clientSession) => clientSession.sessionId !== sessionId,
  );
  emitMockAuthAccess({
    version: 1,
    revision: nextMockAuthAccessRevision(),
    type: "clientRemoved",
    payload: { sessionId: sessionId as never },
  });
}

export function revokeOtherMockClientSessions(): number {
  const removed = mockClientSessions.filter((clientSession) => !clientSession.current);
  for (const clientSession of removed) {
    revokeMockClientSession(clientSession.sessionId);
  }
  return removed.length;
}

export function getMockEnvironmentDescriptor(): ExecutionEnvironmentDescriptor {
  return {
    environmentId: MOCK_ENVIRONMENT_ID,
    label: "codex-remote",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "t3-ui-mock",
    capabilities: { repositoryIdentity: true },
  };
}

export function getMockReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: MOCK_PROJECT_ID,
        title: "codex-remote",
        workspaceRoot: "/Users/ani/workspaces/github.com/anishalle/codex-remote",
        repositoryIdentity: {
          canonicalKey: "github.com/anishalle/codex-remote",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/anishalle/codex-remote.git",
          },
          rootPath: "/Users/ani/workspaces/github.com/anishalle/codex-remote",
          displayName: "codex-remote",
          provider: "github",
          owner: "anishalle",
          name: "codex-remote",
        },
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
      {
        id: "project-claude-code-main" as ProjectId,
        title: "claude-code-main",
        workspaceRoot: "/Users/ani/workspaces/github.com/anthropics/claude-code-main",
        repositoryIdentity: null,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: MOCK_THREAD_ID,
        projectId: MOCK_PROJECT_ID,
        title: "Simple Greeting Reply",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.5",
        },
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        branch: "master",
        worktreePath: null,
        latestTurn: {
          turnId: "turn-simple-greeting" as never,
          state: "completed",
          requestedAt: "2026-04-24T04:15:59.000Z",
          startedAt: "2026-04-24T04:16:00.000Z",
          completedAt: "2026-04-24T04:16:04.700Z",
          assistantMessageId: "msg-assistant-hi" as MessageId,
        },
        createdAt: "2026-04-24T03:55:00.000Z",
        updatedAt: "2026-04-24T04:16:04.700Z",
        archivedAt: null,
        deletedAt: null,
        messages: [
          {
            id: "msg-user-say-hi" as MessageId,
            role: "user",
            text: "say Hi, nothing else",
            turnId: "turn-simple-greeting" as never,
            streaming: false,
            createdAt: "2026-04-24T04:15:59.000Z",
            updatedAt: "2026-04-24T04:15:59.000Z",
          },
          {
            id: "msg-assistant-hi" as MessageId,
            role: "assistant",
            text: "Hi",
            turnId: "turn-simple-greeting" as never,
            streaming: false,
            createdAt: "2026-04-24T04:16:04.000Z",
            updatedAt: "2026-04-24T04:16:04.700Z",
          },
        ],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId: MOCK_THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "auto-accept-edits",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-04-24T04:16:04.700Z",
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

export function getMockShellSnapshot(): OrchestrationShellSnapshot {
  const readModel = getMockReadModel();
  return {
    snapshotSequence: readModel.snapshotSequence,
    projects: readModel.projects.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      repositoryIdentity: project.repositoryIdentity ?? null,
      defaultModelSelection: project.defaultModelSelection,
      scripts: project.scripts,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })),
    threads: readModel.threads.map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      latestTurn: thread.latestTurn,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      archivedAt: thread.archivedAt,
      session: thread.session,
      latestUserMessageAt:
        thread.messages.findLast((message) => message.role === "user")?.createdAt ?? null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    })),
    updatedAt: readModel.updatedAt,
  };
}

export function getMockWelcomePayload(): ServerLifecycleWelcomePayload {
  return {
    environment: getMockEnvironmentDescriptor(),
    cwd: "/Users/ani/workspaces/github.com/anishalle/codex-remote",
    projectName: "codex-remote",
    bootstrapProjectId: MOCK_PROJECT_ID,
    bootstrapThreadId: MOCK_THREAD_ID,
  };
}

export function getMockServerConfig(): ServerConfig {
  const environment = getMockEnvironmentDescriptor();
  return {
    environment,
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "/Users/ani/workspaces/github.com/anishalle/codex-remote",
    keybindingsConfigPath:
      "/Users/ani/workspaces/github.com/anishalle/codex-remote/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        displayName: "Codex",
        badgeLabel: "Codex",
        showInteractionModeToggle: true,
        enabled: true,
        installed: true,
        version: "t3-ui-mock",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: NOW_ISO,
        models: [
          {
            slug: "gpt-5.5",
            name: "GPT-5.5",
            shortName: "GPT-5.5",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "gpt-5.4",
            name: "GPT-5.4",
            shortName: "GPT-5.4",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "gpt-5.3-codex",
            name: "GPT-5.3 Codex",
            shortName: "GPT-5.3",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      },
    ],
    availableEditors: ["cursor", "vscode", "zed", "file-manager"],
    observability: {
      logsDirectoryPath: "/Users/ani/workspaces/github.com/anishalle/codex-remote/.t3/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      defaultThreadEnvMode: "local",
      textGenerationModelSelection: {
        provider: "codex",
        model: "gpt-5.5",
      },
    },
  };
}

export function createMockWsRpcClient(): WsRpcClient {
  const readModel = getMockReadModel();
  const shellSnapshot = getMockShellSnapshot();
  const config = getMockServerConfig();
  const welcome = getMockWelcomePayload();
  const gitStatus: GitStatusResult = {
    isRepo: true,
    hostingProvider: {
      kind: "github",
      name: "GitHub",
      baseUrl: "https://github.com",
    },
    hasOriginRemote: true,
    isDefaultBranch: true,
    branch: "master",
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [
        {
          path: "apps/web/src/main.tsx",
          insertions: 42,
          deletions: 8,
        },
      ],
      insertions: 42,
      deletions: 8,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  };
  const noop = () => undefined;

  return {
    dispose: async () => undefined,
    reconnect: async () => undefined,
    terminal: {
      open: async () => ({ terminalId: "default" }) as never,
      write: async () => undefined as never,
      resize: async () => undefined as never,
      clear: async () => undefined as never,
      restart: async () => undefined as never,
      close: async () => undefined as never,
      onEvent: () => noop,
    },
    projects: {
      searchEntries: async () => ({ entries: [] }) as never,
      writeFile: async () => undefined as never,
    },
    filesystem: {
      browse: async () => ({ entries: [] }) as never,
    },
    shell: {
      openInEditor: async () => undefined,
    },
    git: {
      pull: async () => ({ status: "ok" }) as never,
      refreshStatus: async () => gitStatus as never,
      onStatus: (input, listener) => {
        queueMicrotask(() =>
          listener({
            isRepo: gitStatus.isRepo,
            hostingProvider: gitStatus.hostingProvider,
            hasOriginRemote: gitStatus.hasOriginRemote,
            isDefaultBranch: gitStatus.isDefaultBranch,
            branch: gitStatus.branch,
            hasWorkingTreeChanges: gitStatus.hasWorkingTreeChanges,
            workingTree: gitStatus.workingTree,
            hasUpstream: gitStatus.hasUpstream,
            aheadCount: gitStatus.aheadCount,
            behindCount: gitStatus.behindCount,
            pr: gitStatus.pr,
          }),
        );
        return noop;
      },
      runStackedAction: async () => ({ status: "completed" }) as never,
      listBranches: async () =>
        ({
          branches: [
            {
              name: "master",
              current: true,
              isDefault: true,
              worktreePath: null,
            },
          ],
          isRepo: true,
          hasOriginRemote: true,
          nextCursor: null,
          totalCount: 1,
        }) as never,
      createWorktree: async () => ({}) as never,
      removeWorktree: async () => ({}) as never,
      createBranch: async () => ({}) as never,
      checkout: async () => ({}) as never,
      init: async () => ({}) as never,
      resolvePullRequest: async () => null as never,
      preparePullRequestThread: async () => ({}) as never,
    },
    server: {
      getConfig: async () => config,
      refreshProviders: async () => undefined as never,
      upsertKeybinding: async () => ({ keybindings: [], issues: [] }),
      getSettings: async () => config.settings,
      updateSettings: async () => config.settings,
      subscribeConfig: (listener) => {
        queueMicrotask(() => listener({ version: 1, type: "snapshot", config }));
        return noop;
      },
      subscribeLifecycle: (listener) => {
        queueMicrotask(() =>
          listener({ version: 1, sequence: 1, type: "welcome", payload: welcome }),
        );
        return noop;
      },
      subscribeAuthAccess: (listener) => subscribeMockAuthAccess(listener),
    },
    orchestration: {
      dispatchCommand: async () => ({ status: "accepted" }) as never,
      getTurnDiff: async () => ({ files: [] }) as never,
      getFullThreadDiff: async () => ({ files: [] }) as never,
      subscribeShell: (listener) => {
        queueMicrotask(() => listener({ kind: "snapshot", snapshot: shellSnapshot }));
        return noop;
      },
      subscribeThread: (input, listener) => {
        const thread = readModel.threads.find((entry) => entry.id === input.threadId);
        if (thread) {
          queueMicrotask(() =>
            listener({
              kind: "snapshot",
              snapshot: { snapshotSequence: readModel.snapshotSequence, thread },
            }),
          );
        }
        return noop;
      },
    },
  } satisfies WsRpcClient;
}
