import { stdin as processStdin } from "node:process";

import {
  addProject,
  getCloudCodexPaths,
  loadConfig,
  normalizeServerUrl,
  requireProject,
  requireServerUrl,
  saveConfig,
  type ConfigPaths,
} from "./config.ts";

export interface CliResult {
  readonly exitCode: number;
}

interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const defaultIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

export async function runCli(
  argv: readonly string[],
  input: {
    readonly paths?: ConfigPaths;
    readonly io?: CliIo;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<CliResult> {
  const io = input.io ?? defaultIo;
  const paths = input.paths ?? getCloudCodexPaths(input.env);
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case "login":
        return commandLogin(rest, paths, io);
      case "pair":
        return commandPair(rest, paths, io, input.env ?? process.env);
      case "daemon":
        return await commandDaemon(rest, paths, io);
      case "project":
        return commandProject(rest, paths, io);
      case "run":
        return await commandRun(rest, paths, io);
      case "-h":
      case "--help":
      case undefined:
        io.stdout(usage());
        return { exitCode: 0 };
      default:
        throw new Error(`Unknown command "${command}".`);
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return { exitCode: 1 };
  }
}

function commandLogin(args: readonly string[], paths: ConfigPaths, io: CliIo): CliResult {
  const serverUrl = args[0];
  if (!serverUrl) {
    throw new Error("Usage: cloudcodex login <server-url>");
  }
  const config = loadConfig(paths);
  saveConfig(
    {
      ...config,
      serverUrl: normalizeServerUrl(serverUrl),
    },
    paths,
  );
  io.stdout(`Saved cloud-server URL to ${paths.configPath}`);
  return { exitCode: 0 };
}

async function commandPair(
  args: readonly string[],
  paths: ConfigPaths,
  io: CliIo,
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  const name = readOption(args, "--name") ?? loadConfig(paths).deviceName;
  const token = firstPositional(args) ?? env.CLOUD_CODEX_PAIRING_TOKEN ?? (await readTokenFromStdin());
  if (!token) {
    throw new Error("Usage: cloudcodex pair <pairing-token> [--name <device-name>]");
  }
  const config = loadConfig(paths);
  const serverUrl = requireServerUrl(config);
  const response = await fetch(`${serverUrl}/api/pairing/finish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      pairingToken: token.trim(),
      deviceName: name,
      deviceKind: "runner",
    }),
  });
  const body = await response.json() as any;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Pairing failed with HTTP ${response.status}.`);
  }
  saveConfig(
    {
      ...config,
      sessionToken: body.sessionToken,
      sessionId: body.sessionId,
      deviceId: body.deviceId,
      deviceName: name,
      runnerName: name,
    },
    paths,
  );
  io.stdout(`Paired runner device ${body.deviceId}`);
  return { exitCode: 0 };
}

async function commandDaemon(
  args: readonly string[],
  paths: ConfigPaths,
  io: CliIo,
): Promise<CliResult> {
  const once = args.includes("--once");
  const config = loadConfig(paths);
  const { RunnerStateDatabase } = await import("./state.ts");
  const state = new RunnerStateDatabase(paths.stateDbPath);
  try {
    if (once) {
      const { connectAndFlushOnce } = await import("./runner.ts");
      const result = await connectAndFlushOnce({
        config,
        state,
        logger: cliLogger(io),
      });
      io.stdout(`Flushed ${result.acked}/${result.sent} queued events`);
      return { exitCode: 0 };
    }

    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => controller.abort());
    }
    const { MacRunnerDaemon } = await import("./runner.ts");
    await new MacRunnerDaemon({
      config,
      state,
      options: {
        signal: controller.signal,
        logger: cliLogger(io),
      },
    }).run();
    return { exitCode: 0 };
  } finally {
    state.close();
  }
}

function commandProject(args: readonly string[], paths: ConfigPaths, io: CliIo): CliResult {
  if (args[0] !== "add") {
    throw new Error("Usage: cloudcodex project add <path> --name <name>");
  }
  const projectPath = args[1];
  const name = readOption(args.slice(2), "--name");
  if (!projectPath || !name) {
    throw new Error("Usage: cloudcodex project add <path> --name <name>");
  }
  const config = addProject(loadConfig(paths), {
    name,
    path: projectPath,
  });
  saveConfig(config, paths);
  io.stdout(`Added project ${name}`);
  return { exitCode: 0 };
}

async function commandRun(
  args: readonly string[],
  paths: ConfigPaths,
  io: CliIo,
): Promise<CliResult> {
  const projectName = args[0];
  const prompt = args.slice(1).join(" ").trim();
  if (!projectName || !prompt) {
    throw new Error("Usage: cloudcodex run <project> <prompt>");
  }
  const config = loadConfig(paths);
  const project = requireProject(config, projectName);
  const { RunnerStateDatabase } = await import("./state.ts");
  const { connectAndFlushOnce, enqueueMockRun } = await import("./runner.ts");
  const state = new RunnerStateDatabase(paths.stateDbPath);
  try {
    const queued = enqueueMockRun({
      state,
      runnerId: config.runnerId,
      project,
      prompt,
    });
    io.stdout(`Queued mocked thread ${queued.threadId}`);
    if (config.serverUrl && config.sessionToken) {
      try {
        const result = await connectAndFlushOnce({
          config,
          state,
          timeoutMs: 5000,
          logger: cliLogger(io),
        });
        io.stdout(`Flushed ${result.acked}/${result.sent} queued events`);
      } catch (error) {
        io.stderr(
          `Queued locally; daemon will retry later: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { exitCode: 0 };
  } finally {
    state.close();
  }
}

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function firstPositional(args: readonly string[]): string | undefined {
  return args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--name");
}

async function readTokenFromStdin(): Promise<string | undefined> {
  if (processStdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of processStdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim() || undefined;
}

function cliLogger(io: CliIo) {
  return {
    info: (message: string) => io.stdout(message),
    warn: (message: string) => io.stderr(message),
    error: (message: string) => io.stderr(message),
  };
}

function usage(): string {
  return [
    "Usage:",
    "  cloudcodex login <server-url>",
    "  cloudcodex pair <pairing-token> [--name <device-name>]",
    "  cloudcodex daemon [--once]",
    "  cloudcodex project add <path> --name <name>",
    "  cloudcodex run <project> <prompt>",
  ].join("\n");
}
