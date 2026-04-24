import { DEFAULT_MODEL_BY_PROVIDER, MessageId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  codexCliProjectIdForCwd,
  codexCliThreadIdForSessionId,
  parseCodexCliSessionJsonl,
} from "./CodexCliSessionImporter.ts";

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
  });
});
