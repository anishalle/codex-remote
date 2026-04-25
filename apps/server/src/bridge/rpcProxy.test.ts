import {
  ProjectId,
  ThreadId,
  type OrchestrationShellStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { forwardBridgeShellItem } from "./rpcProxy.ts";

describe("forwardBridgeShellItem", () => {
  it("preserves older shell snapshots instead of filtering them at bridge connect time", () => {
    const snapshot: OrchestrationShellStreamItem = {
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 42,
        updatedAt: "2026-04-24T12:00:00.000Z",
        projects: [
          {
            id: ProjectId.make("project-1"),
            title: "Project 1",
            workspaceRoot: "/workspace/project-1",
            repositoryIdentity: null,
            defaultModelSelection: {
              provider: "codex",
              model: "gpt-5.5",
            },
            scripts: [],
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        ],
        threads: [
          {
            id: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-1"),
            title: "Older thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.5",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            latestTurn: null,
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
            archivedAt: null,
            session: null,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
          },
        ],
      },
    };

    expect(forwardBridgeShellItem(snapshot)).toEqual(snapshot);
  });

  it("preserves project and thread upserts for older local state", () => {
    const projectUpsert: OrchestrationShellStreamItem = {
      kind: "project-upserted",
      sequence: 43,
      project: {
        id: ProjectId.make("project-1"),
        title: "Project 1",
        workspaceRoot: "/workspace/project-1",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    };
    const threadUpsert: OrchestrationShellStreamItem = {
      kind: "thread-upserted",
      sequence: 44,
      thread: {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Older thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
        archivedAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: true,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    };

    expect(forwardBridgeShellItem(projectUpsert)).toEqual(projectUpsert);
    expect(forwardBridgeShellItem(threadUpsert)).toEqual(threadUpsert);
  });
});
