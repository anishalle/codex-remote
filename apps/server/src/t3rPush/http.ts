import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { respondToAuthError } from "../auth/http.ts";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import {
  codexCliThreadIdForSessionId,
  importCodexCliSessionReadModel,
  parseCodexCliSessionJsonl,
} from "../bridge/CodexCliSessionImporter.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";

const T3R_PUSH_WORKSPACE_ROOT = process.env.T3R_PUSH_WORKSPACE_ROOT?.trim() || "/workspace";
const T3R_PUSH_METADATA_DIR = ".t3r-push";
const T3R_PUSH_SESSION_JSONL = "session.jsonl";
const MAX_REPO_NAME_LENGTH = 160;

function readHeader(request: HttpServerRequest.HttpServerRequest, name: string): string | null {
  const value = request.headers[name.toLowerCase()];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function validateRepoName(rawRepoName: string): string | null {
  const repoName = rawRepoName.trim();
  if (
    repoName.length === 0 ||
    repoName.length > MAX_REPO_NAME_LENGTH ||
    repoName === "." ||
    repoName === ".." ||
    repoName.includes("/") ||
    repoName.includes("\\") ||
    repoName.includes("\0")
  ) {
    return null;
  }
  return repoName;
}

function runProcess(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolve({ stdout: stdoutText, stderr: stderrText });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}${
            stderrText ? `: ${stderrText}` : ""
          }`,
        ),
      );
    });
  });
}

function validateTarEntries(listing: string): void {
  for (const rawEntry of listing.split("\n")) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }
    const normalized = entry.replace(/^\.\//, "");
    if (
      entry.startsWith("/") ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      normalized.includes("\0")
    ) {
      throw new Error(`Archive contains an unsafe path: ${entry}`);
    }
  }
}

async function extractPushArchive(input: {
  readonly archivePath: string;
  readonly repoName: string;
}): Promise<string> {
  const workspaceRoot = path.resolve(T3R_PUSH_WORKSPACE_ROOT);
  const uploadPath = path.join(workspaceRoot, `.t3r-upload-${input.repoName}-${randomUUID()}`);
  const workspacePath = path.join(workspaceRoot, input.repoName);

  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(uploadPath, { recursive: true });

  try {
    const listing = await runProcess("tar", ["-tzf", input.archivePath]);
    validateTarEntries(listing.stdout);
    await runProcess("tar", ["-xzf", input.archivePath, "-C", uploadPath]);

    await rm(workspacePath, { recursive: true, force: true });
    await rename(uploadPath, workspacePath);
    return workspacePath;
  } catch (error) {
    await rm(uploadPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

const authenticateOwnerSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  if (session.role !== "owner") {
    return yield* new AuthError({
      message: "Only owner sessions can push t3r workspaces.",
      status: 403,
    });
  }
  return session;
});

export const t3rPushRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3r/push",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const repoNameHeader = readHeader(request, "x-t3r-repo-name");
    const repoName = repoNameHeader ? validateRepoName(decodeHeaderValue(repoNameHeader)) : null;
    if (repoName === null) {
      return HttpServerResponse.jsonUnsafe({ error: "Invalid t3r repo name." }, { status: 400 });
    }

    const body = yield* request.arrayBuffer.pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid t3r push archive.",
            status: 400,
            cause,
          }),
      ),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => path.join(os.tmpdir(), `t3r-push-${randomUUID()}.tar.gz`)),
      (archivePath) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() => writeFile(archivePath, Buffer.from(body)));
          const workspacePath = yield* Effect.tryPromise(() =>
            extractPushArchive({ archivePath, repoName }),
          );
          const sessionJsonlPath = path.join(
            workspacePath,
            T3R_PUSH_METADATA_DIR,
            T3R_PUSH_SESSION_JSONL,
          );
          const sessionContents = yield* Effect.tryPromise(() => readFile(sessionJsonlPath, "utf8"));
          const now = new Date().toISOString();
          const parsed = parseCodexCliSessionJsonl({
            filePath: sessionJsonlPath,
            contents: sessionContents,
            updatedAt: now,
          });
          if (parsed === null) {
            return HttpServerResponse.jsonUnsafe(
              { error: "The pushed archive did not contain a usable Codex session." },
              { status: 400 },
            );
          }

          const remoteSession = {
            ...parsed,
            cwd: workspacePath,
            updatedAt: now,
          };
          yield* importCodexCliSessionReadModel(remoteSession);

          const orchestrationEngine = yield* OrchestrationEngineService;
          const readModel = yield* orchestrationEngine.getReadModel();
          const project = readModel.projects.find(
            (entry) => entry.deletedAt === null && entry.workspaceRoot === workspacePath,
          );
          const threadId = codexCliThreadIdForSessionId(remoteSession.sessionId);

          return HttpServerResponse.jsonUnsafe(
            {
              ok: true,
              workspacePath,
              repoName,
              projectId: project?.id ?? null,
              threadId,
              title: remoteSession.title,
              messageCount: remoteSession.messages.length,
              activityCount: remoteSession.activities.length,
            },
            { status: 200 },
          );
        }),
      (archivePath) => Effect.promise(() => rm(archivePath, { force: true }).catch(() => undefined)),
    );
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Effect.logError("t3r push failed", {
          cause: error,
        });
        return HttpServerResponse.jsonUnsafe(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }),
    ),
  ),
);
