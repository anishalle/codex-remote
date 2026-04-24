import type { CloudEvent } from "../../protocol/src/index.ts";
import type { HandoffManifest } from "./manifest.ts";

export function summarizeEvents(events: readonly CloudEvent[]): string {
  const lines: string[] = [];
  for (const event of events.slice(-80)) {
    const rendered = renderEvent(event);
    if (rendered) lines.push(rendered);
  }
  if (lines.length === 0) {
    return "No prior CloudCodex events were exported for this handoff.";
  }
  return lines.join("\n").slice(0, 6000);
}

export function generateHandoffPrompt(input: {
  readonly manifest: HandoffManifest;
  readonly summary?: string;
  readonly userInstruction?: string;
}): string {
  const summary = (input.summary || input.manifest.conversation.summary).trim();
  const instruction = input.userInstruction?.trim();
  return [
    "Continue this Codex task from a CloudCodex handoff.",
    "",
    "Workspace state:",
    `- A safe git bundle was unpacked for ${input.manifest.source.workspaceName}.`,
    `- Source git HEAD: ${input.manifest.source.gitHead}.`,
    `- Approved untracked overlay files: ${input.manifest.overlay.files.length}.`,
    `- Exported CloudCodex events: ${input.manifest.conversation.exportedEventCount}.`,
    "",
    "Important constraints:",
    "- This is a handoff continuation, not raw Codex thread-file migration.",
    "- Trust only files present in the unpacked workspace and this prompt.",
    "- Re-check the workspace before editing and continue from the summary below.",
    "",
    "Handoff summary:",
    summary,
    ...(instruction ? ["", "User instruction:", instruction] : []),
  ].join("\n");
}

function renderEvent(event: CloudEvent): string {
  const payload = normalizePayload(event.payload);
  const method = typeof payload.method === "string" ? payload.method : event.type;
  if (method.includes("agentMessage") || event.type.includes("message")) {
    const text = extractString(payload, ["params.delta", "params.text", "delta", "text", "message"]);
    return text ? `assistant: ${text}` : "";
  }
  if (method.includes("plan")) {
    return `plan: ${JSON.stringify(payload).slice(0, 500)}`;
  }
  if (method.includes("command") || event.type.includes("command")) {
    const text = extractString(payload, ["params.delta", "params.output", "delta", "output", "message"]);
    return text ? `command: ${text}` : "";
  }
  if (event.type.includes("error") || method.includes("error")) {
    return `error: ${JSON.stringify(payload).slice(0, 500)}`;
  }
  return "";
}

function normalizePayload(payload: unknown): Record<string, unknown> {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (typeof record.data === "object" && record.data !== null && !Array.isArray(record.data)) {
      return record.data as Record<string, unknown>;
    }
    return record;
  }
  return {};
}

function extractString(value: Record<string, unknown>, paths: readonly string[]): string {
  for (const path of paths) {
    const found = getPath(value, path);
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return "";
}

function getPath(value: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (typeof current === "object" && current !== null && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, value);
}
