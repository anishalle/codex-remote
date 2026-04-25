import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  codexCliProjectIdForCwd,
  codexCliThreadIdForSessionId,
  importCodexCliSessionReadModel,
  parseCodexCliSessionJsonl,
  shouldImportCodexCliTranscript,
} from "./CodexCliSessionImporter.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerConfig } from "../config.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";

describe("parseCodexCliSessionJsonl", () => {
  it("extracts metadata, cwd, model, and first user prompt from Codex CLI JSONL", () => {
    const parsed = parseCodexCliSessionJsonl({
      filePath: "/tmp/session.jsonl",
      updatedAt: "2026-04-24T08:00:00.000Z",
      contents: [
        JSON.stringify({
          timestamp: "2026-04-24T07:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019dbe5a-242b-76b2-94bd-7e404b216fac",
            timestamp: "2026-04-24T07:00:00.000Z",
            cwd: "/repo",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-24T07:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Fix the bridge visibility bug on phone",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-24T07:01:30.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "I will inspect the bridge importer.",
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-24T07:02:00.000Z",
          type: "turn_context",
          payload: {
            cwd: "/repo",
            model: "gpt-5.5",
          },
        }),
      ].join("\n"),
    });

    assert.deepStrictEqual(parsed, {
      sessionId: "019dbe5a-242b-76b2-94bd-7e404b216fac",
      cwd: "/repo",
      title: "Fix the bridge visibility bug on phone",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.5",
      },
      sessionStartedAt: "2026-04-24T07:00:00.000Z",
      updatedAt: "2026-04-24T08:00:00.000Z",
      messages: [
        {
          messageId: MessageId.make("codex-cli:019dbe5a-242b-76b2-94bd-7e404b216fac:msg:1"),
          role: "user",
          text: "Fix the bridge visibility bug on phone",
          createdAt: "2026-04-24T07:01:00.000Z",
          updatedAt: "2026-04-24T07:01:00.000Z",
        },
        {
          messageId: MessageId.make("codex-cli:019dbe5a-242b-76b2-94bd-7e404b216fac:msg:2"),
          role: "assistant",
          text: "I will inspect the bridge importer.",
          createdAt: "2026-04-24T07:01:30.000Z",
          updatedAt: "2026-04-24T07:01:30.000Z",
        },
      ],
      activities: [],
    });
  });

  it("imports Codex CLI tool calls as deterministic thread activities", () => {
    const parsed = parseCodexCliSessionJsonl({
      filePath: "/tmp/session.jsonl",
      updatedAt: "2026-04-24T08:00:00.000Z",
      contents: [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "session-tools",
            cwd: "/repo",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-24T07:01:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "git status --short",
              workdir: "/repo",
            }),
            call_id: "call_1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-24T07:01:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_1",
            output: "Output:\n## t3\n",
          },
        }),
      ].join("\n"),
    });

    assert.equal(parsed?.activities.length, 1);
    assert.deepStrictEqual(parsed?.activities[0], {
      id: EventId.make("codex-cli:session-tools:activity:1"),
      tone: "tool",
      kind: "codex-cli.tool",
      summary: "exec_command: git status --short",
      payload: {
        source: "codex-cli",
        itemType: "exec_command",
        callId: "call_1",
        status: "completed",
        detail: "git status --short",
        arguments: {
          cmd: "git status --short",
          workdir: "/repo",
        },
        output: "Output:\n## t3",
        outputTruncated: false,
        outputCreatedAt: "2026-04-24T07:01:01.000Z",
        outputSourceIndex: 2,
      },
      turnId: null,
      sequence: 1,
      createdAt: "2026-04-24T07:01:00.000Z",
    });
  });

  it("uses stable imported ids and default model fallback", () => {
    const threadId = codexCliThreadIdForSessionId("session-a");
    const projectId = codexCliProjectIdForCwd("/repo");
    const parsed = parseCodexCliSessionJsonl({
      filePath: "/tmp/session.jsonl",
      updatedAt: "2026-04-24T08:00:00.000Z",
      contents: JSON.stringify({
        type: "session_meta",
        payload: {
          id: "session-a",
          cwd: "/repo",
        },
      }),
    });

    assert.equal(threadId, "codex-cli:session-a");
    assert.match(projectId, /^codex-cli-project:[a-f0-9]{16}$/);
    assert.equal(parsed?.modelSelection.model, DEFAULT_MODEL_BY_PROVIDER.codex);
    assert.deepStrictEqual(parsed?.messages, []);
    assert.deepStrictEqual(parsed?.activities, []);
  });

  it("skips transcript replay when a live Codex runtime already owns the same session", () => {
    assert.equal(
      shouldImportCodexCliTranscript("session-a", {
        provider: "codex",
        threadId: codexCliThreadIdForSessionId("session-a"),
        resumeCursor: {
          threadId: "session-a",
        },
        runtimePayload: {
          source: "provider-runtime",
        },
      }),
      false,
    );
    assert.equal(
      shouldImportCodexCliTranscript("session-a", {
        provider: "codex",
        threadId: codexCliThreadIdForSessionId("session-a"),
        resumeCursor: {
          threadId: "session-a",
        },
        runtimePayload: {
          source: "codex-cli-import",
        },
      }),
      true,
    );
    assert.equal(
      shouldImportCodexCliTranscript("session-a", {
        provider: "codex",
        threadId: codexCliThreadIdForSessionId("session-a"),
        resumeCursor: {
          threadId: "session-a",
        },
        runtimePayload: {},
      }),
      false,
    );
  });

  it.effect("unarchives a live Codex CLI thread even when transcript replay is skipped", () =>
    Effect.gen(function* () {
      const orchestrationLayer = OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provide(SqlitePersistenceMemory),
      );
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
      const layer = Layer.mergeAll(orchestrationLayer, directoryLayer).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-codex-cli-import-test-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const directory = yield* ProviderSessionDirectory;
        const sessionId = "session-live";
        const threadId = codexCliThreadIdForSessionId(sessionId);
        const projectId = ProjectId.make("project-live");
        const archivedAt = "2026-04-24T07:00:00.000Z";

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-live-create"),
          projectId,
          title: "Repo",
          workspaceRoot: "/repo",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          createdAt: archivedAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-live-create"),
          threadId,
          projectId,
          title: "New thread",
          modelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: archivedAt,
        });
        yield* engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-live-archive"),
          threadId,
        });
        yield* directory.upsert({
          threadId,
          provider: "codex",
          runtimeMode: "full-access",
          status: "running",
          resumeCursor: {
            threadId: sessionId,
          },
          runtimePayload: {
            source: "provider-runtime",
          },
        });

        yield* importCodexCliSessionReadModel({
          sessionId,
          cwd: "/repo",
          title: "Keep visible",
          modelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          sessionStartedAt: archivedAt,
          updatedAt: new Date().toISOString(),
          messages: [
            {
              messageId: MessageId.make("codex-cli:session-live:msg:1"),
              role: "user",
              text: "keep this thread visible",
              createdAt: archivedAt,
              updatedAt: archivedAt,
            },
          ],
          activities: [],
        });

        const readModel = yield* engine.getReadModel();
        const thread = readModel.threads.find((entry) => entry.id === threadId);
        assert.equal(thread !== undefined, true);
        assert.equal(thread?.archivedAt, null);
        assert.equal(thread?.messages.length ?? 0, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("marks recently updated imported Codex CLI sessions as running", () =>
    Effect.gen(function* () {
      const orchestrationLayer = OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provide(SqlitePersistenceMemory),
      );
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
      const layer = Layer.mergeAll(orchestrationLayer, directoryLayer).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-codex-cli-running-test-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;

        yield* importCodexCliSessionReadModel({
          sessionId: "session-running",
          cwd: "/repo-running",
          title: "Show running state",
          modelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          sessionStartedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
          activities: [],
        });

        const thread = (yield* engine.getReadModel()).threads.find(
          (entry) => entry.id === codexCliThreadIdForSessionId("session-running"),
        );
        assert.equal(thread !== undefined, true);
        assert.equal(thread?.session?.status, "running");
      }).pipe(Effect.provide(layer));
    }),
  );
});
