import { createCloudProject, listCloudProjects } from "./path-guard.ts";
import {
  ensureCloudRunnerHome,
  loadCloudRunnerConfig,
  toMacRunnerConfig,
  writeSessionToken,
} from "./config.ts";
import { unpackHandoffWorkspace } from "./unpack.ts";

interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

interface RunnerLogger {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
}

const defaultIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

export async function runCli(
  argv: readonly string[],
  input: { readonly env?: NodeJS.ProcessEnv; readonly io?: CliIo } = {},
): Promise<number> {
  const env = input.env ?? process.env;
  const io = input.io ?? defaultIo;
  const command = argv[0] ?? "daemon";
  try {
    switch (command) {
      case "daemon":
        await runDaemon(env, io);
        return 0;
      case "pair":
        await pairRunner(argv.slice(1), env, io);
        return 0;
      case "project":
        return runProjectCommand(argv.slice(1), env, io);
      case "-h":
      case "--help":
      case "help":
        io.stdout(usage());
        return 0;
      default:
        throw new Error(`Unknown command "${command}".`);
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runDaemon(env: NodeJS.ProcessEnv, io: CliIo): Promise<void> {
  const config = loadCloudRunnerConfig(env);
  ensureCloudRunnerHome(config);
  const projects = listCloudProjects(config.workspacesRoot);
  const [{ CodexRuntimeBridge }, { MacRunnerDaemon }, { RunnerStateDatabase }] = await Promise.all([
    import("../../mac-runner-cli/src/local-codex.ts"),
    import("../../mac-runner-cli/src/runner.ts"),
    import("../../mac-runner-cli/src/state.ts"),
  ]);
  const state = new RunnerStateDatabase(config.stateDbPath);
  const logger = cliLogger(io);
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => controller.abort());
  }
  try {
    await new MacRunnerDaemon({
      config: toMacRunnerConfig(config, projects),
      state,
      options: {
        signal: controller.signal,
        logger,
        runtimeBridge: new CodexRuntimeBridge({
          ...(config.codexBinary ? { binaryPath: config.codexBinary } : {}),
          codexHome: config.codexHome,
          logger,
        }),
        projectManager: {
          createProject: async (request) => {
            const project = createCloudProject({
              workspacesRoot: config.workspacesRoot,
              projectId: request.projectId,
              name: request.name,
            });
            return {
              name: project.projectId,
              path: project.path,
              addedAt: project.addedAt,
            };
          },
          unpackWorkspace: async (request) =>
            unpackHandoffWorkspace({
              config,
              uploadId: request.uploadId,
              projectId: request.projectId,
            }),
        },
      },
    }).run();
  } finally {
    state.close();
  }
}

async function pairRunner(args: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<void> {
  const pairingToken = firstPositional(args) ?? env.CLOUD_CODEX_PAIRING_TOKEN;
  if (!pairingToken) {
    throw new Error("Usage: cloudcodex-cloud-runner pair <pairing-token> [--name <runner-name>]");
  }
  const config = loadCloudRunnerConfig(env);
  const deviceName = readOption(args, "--name") ?? config.runnerName;
  const response = await fetch(`${config.serverUrl}/api/pairing/finish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      pairingToken,
      deviceName,
      deviceKind: "runner",
    }),
  });
  const body = (await response.json()) as any;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Pairing failed with HTTP ${response.status}.`);
  }
  writeSessionToken(config, body.sessionToken);
  io.stdout(`Paired cloud runner device ${body.deviceId}; token written to ${config.sessionTokenPath}`);
}

function runProjectCommand(args: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): number {
  const subcommand = args[0];
  const config = loadCloudRunnerConfig(env);
  ensureCloudRunnerHome(config);
  if (subcommand === "create") {
    const projectId = args[1];
    if (!projectId) {
      throw new Error("Usage: cloudcodex-cloud-runner project create <project-id> [--name <name>]");
    }
    const project = createCloudProject({
      workspacesRoot: config.workspacesRoot,
      projectId,
      name: readOption(args.slice(2), "--name"),
    });
    io.stdout(`${project.projectId}\t${project.path}`);
    return 0;
  }
  if (subcommand === "list") {
    for (const project of listCloudProjects(config.workspacesRoot)) {
      io.stdout(`${project.projectId}\t${project.path}`);
    }
    return 0;
  }
  throw new Error("Usage: cloudcodex-cloud-runner project <create|list>");
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

function cliLogger(io: CliIo): RunnerLogger {
  return {
    info: (message) => io.stdout(message),
    warn: (message) => io.stderr(message),
    error: (message) => io.stderr(message),
  };
}

function usage(): string {
  return [
    "Usage:",
    "  cloudcodex-cloud-runner daemon",
    "  cloudcodex-cloud-runner pair <pairing-token> [--name <runner-name>]",
    "  cloudcodex-cloud-runner project create <project-id> [--name <name>]",
    "  cloudcodex-cloud-runner project list",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
