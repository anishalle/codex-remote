#!/usr/bin/env node

const require_chunk = require('./chunk-DlKPiV2v.cjs');
const require_cli = require('./cli-BjU8Fw9s.cjs');
require('./PTY-BNE-GnF4.cjs');
let _effect_platform_node_NodeRuntime = require("@effect/platform-node/NodeRuntime");
_effect_platform_node_NodeRuntime = require_chunk.__toESM(_effect_platform_node_NodeRuntime);
let _effect_platform_node_NodeServices = require("@effect/platform-node/NodeServices");
_effect_platform_node_NodeServices = require_chunk.__toESM(_effect_platform_node_NodeServices);
let effect = require("effect");
let node_fs = require("node:fs");
node_fs = require_chunk.__toESM(node_fs);
let node_readline = require("node:readline");
node_readline = require_chunk.__toESM(node_readline);
let node_os = require("node:os");
node_os = require_chunk.__toESM(node_os);
let node_child_process = require("node:child_process");
let node_path = require("node:path");
node_path = require_chunk.__toESM(node_path);
let node_url = require("node:url");
let node_fs_promises = require("node:fs/promises");
node_fs_promises = require_chunk.__toESM(node_fs_promises);
let node_readline_promises = require("node:readline/promises");
let node_process = require("node:process");
node_process = require_chunk.__toESM(node_process);

//#region src/t3r.ts
const DEFAULT_REMOTE_URL = "https://codex.anishalle.com";
const INTERNAL_DAEMON_COMMAND = "__daemon";
const PUSH_LOOKBACK_MS = 10 * 6e4;
const ONE_GIB = 1024 * 1024 * 1024;
const T3R_PUSH_METADATA_DIR = ".t3r-push";
function resolveConfigDir() {
	const configured = node_process.default.env.T3R_CONFIG_DIR?.trim();
	if (configured) return node_path.default.resolve(configured.replace(/^~(?=$|\/)/, node_os.default.homedir()));
	const xdgConfigHome = node_process.default.env.XDG_CONFIG_HOME?.trim();
	const root = xdgConfigHome ? node_path.default.resolve(xdgConfigHome) : node_path.default.join(node_os.default.homedir(), ".config");
	return node_path.default.join(root, "t3r");
}
function resolveRemoteUrl() {
	const configured = node_process.default.env.T3R_REMOTE_URL?.trim();
	return new URL(configured || DEFAULT_REMOTE_URL).toString();
}
function resolvePaths() {
	const configDir = resolveConfigDir();
	return {
		configDir,
		tokenPath: node_process.default.env.T3R_TOKEN_FILE?.trim() || node_path.default.join(configDir, "token"),
		pidPath: node_process.default.env.T3R_PID_FILE?.trim() || node_path.default.join(configDir, "t3r.pid"),
		logPath: node_process.default.env.T3R_LOG_FILE?.trim() || node_path.default.join(configDir, "t3r.log")
	};
}
function endpointUrl(baseUrl, pathname) {
	const url = new URL(baseUrl);
	url.pathname = pathname;
	url.search = "";
	url.hash = "";
	return url.toString();
}
async function readResponseError(response, fallback) {
	const text = await response.text().catch(() => "");
	if (!text) return fallback;
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed.error === "string" && parsed.error.trim().length > 0) return parsed.error;
	} catch {}
	return text;
}
async function readSavedToken(tokenPath) {
	try {
		const token = (await node_fs_promises.readFile(tokenPath, "utf8")).trim();
		return token.length > 0 ? token : null;
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
async function writeSavedToken(tokenPath, token) {
	await node_fs_promises.mkdir(node_path.default.dirname(tokenPath), {
		recursive: true,
		mode: 448
	});
	await node_fs_promises.writeFile(tokenPath, `${token.trim()}\n`, { mode: 384 });
	await node_fs_promises.chmod(tokenPath, 384).catch(() => void 0);
}
async function validateSavedToken(remoteUrl, token) {
	try {
		const response = await fetch(endpointUrl(remoteUrl, "/api/auth/session"), { headers: { authorization: `Bearer ${token}` } });
		if (!response.ok) return response.status === 401 || response.status === 403 ? "invalid" : "unknown";
		return (await response.json()).authenticated === true ? "valid" : "invalid";
	} catch {
		return "unknown";
	}
}
function extractPairingCredential(rawInput) {
	const trimmed = rawInput.trim();
	if (trimmed.length === 0) return "";
	try {
		const url = new URL(trimmed);
		const hashToken = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash).get("token")?.trim();
		if (hashToken) return hashToken;
		const searchToken = url.searchParams.get("token")?.trim();
		if (searchToken) return searchToken;
	} catch {}
	const fragment = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
	return new URLSearchParams(fragment).get("token")?.trim() || trimmed;
}
async function promptForPairingCredential(remoteUrl) {
	if (!node_process.default.stdin.isTTY || !node_process.default.stdout.isTTY) throw new Error("t3r needs a pairing link or token the first time. Run it in an interactive terminal.");
	console.log(`t3r needs auth for ${remoteUrl}`);
	console.log("Create a pairing link in T3, then paste the full link or token here.");
	const rl = (0, node_readline_promises.createInterface)({
		input: node_process.default.stdin,
		output: node_process.default.stdout
	});
	try {
		return extractPairingCredential(await rl.question("Pairing link or token: "));
	} finally {
		rl.close();
	}
}
async function bootstrapBearerToken(remoteUrl, credential) {
	const response = await fetch(endpointUrl(remoteUrl, "/api/auth/bootstrap/bearer"), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ credential })
	});
	if (!response.ok) throw new Error(await readResponseError(response, `Remote auth failed with status ${response.status}.`));
	const result = await response.json();
	if (typeof result.sessionToken !== "string" || result.sessionToken.trim().length === 0) throw new Error("Remote auth did not return a bearer token.");
	return result.sessionToken.trim();
}
async function ensureBridgeToken(remoteUrl, paths) {
	await node_fs_promises.mkdir(paths.configDir, {
		recursive: true,
		mode: 448
	});
	await node_fs_promises.chmod(paths.configDir, 448).catch(() => void 0);
	const savedToken = await readSavedToken(paths.tokenPath);
	if (savedToken) {
		const validation = await validateSavedToken(remoteUrl, savedToken);
		if (validation === "valid") return { refreshed: false };
		if (validation === "unknown") {
			console.warn("Could not validate saved t3r auth. Starting with the saved token.");
			return { refreshed: false };
		}
		console.log("Saved t3r auth is expired or revoked.");
	}
	for (;;) {
		const credential = await promptForPairingCredential(remoteUrl);
		if (!credential) {
			console.log("No token entered.");
			continue;
		}
		try {
			const token = await bootstrapBearerToken(remoteUrl, credential);
			await writeSavedToken(paths.tokenPath, token);
			console.log(`Saved t3r auth to ${paths.tokenPath}`);
			return { refreshed: true };
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
		}
	}
}
async function readPid(pidPath) {
	try {
		const raw = (await node_fs_promises.readFile(pidPath, "utf8")).trim();
		const pid = Number.parseInt(raw, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
function isProcessAlive(pid) {
	try {
		node_process.default.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
async function removePidFile(pidPath) {
	await node_fs_promises.unlink(pidPath).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
}
async function delay(ms) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
function formatBytes(bytes) {
	if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}
function runProcess(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = (0, node_child_process.spawn)(command, args, {
			cwd: options.cwd,
			stdio: options.stdio === "inherit" ? "inherit" : [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		const stdout = [];
		const stderr = [];
		if (child.stdout) child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		if (child.stderr) child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("error", reject);
		child.on("close", (code) => {
			const stdoutText = Buffer.concat(stdout).toString("utf8");
			const stderrText = Buffer.concat(stderr).toString("utf8");
			if (code === 0) {
				resolve({
					stdout: stdoutText,
					stderr: stderrText
				});
				return;
			}
			reject(/* @__PURE__ */ new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}${stderrText ? `: ${stderrText}` : ""}`));
		});
	});
}
async function execFileStdout(command, args) {
	return await new Promise((resolve, reject) => {
		(0, node_child_process.execFile)(command, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr || error.message));
				return;
			}
			resolve(stdout);
		});
	});
}
async function directorySizeBytes(directory) {
	const output = await execFileStdout("du", ["-sk", directory]);
	const sizeKiB = Number.parseInt(output.trim().split(/\s+/)[0] ?? "", 10);
	if (!Number.isFinite(sizeKiB) || sizeKiB < 0) throw new Error(`Could not calculate workspace size for ${directory}.`);
	return sizeKiB * 1024;
}
async function confirmPrompt(question) {
	const rl = (0, node_readline_promises.createInterface)({
		input: node_process.default.stdin,
		output: node_process.default.stdout
	});
	try {
		const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}
function codexSessionsRoot() {
	const codexHome = node_process.default.env.CODEX_HOME?.trim() || node_path.default.join(node_os.default.homedir(), ".codex");
	return node_path.default.join(codexHome, "sessions");
}
async function resolvePushUpdatedSinceMs(paths) {
	const pid = await readPid(paths.pidPath);
	if (pid && isProcessAlive(pid)) try {
		return (await node_fs_promises.stat(paths.pidPath)).mtimeMs - PUSH_LOOKBACK_MS;
	} catch {
		return Date.now() - PUSH_LOOKBACK_MS;
	}
	return Date.now() - PUSH_LOOKBACK_MS;
}
function buildPushCandidates(loaded) {
	const repoCounts = /* @__PURE__ */ new Map();
	for (const entry of loaded) {
		const repoName = node_path.default.basename(entry.session.cwd);
		repoCounts.set(repoName, (repoCounts.get(repoName) ?? 0) + 1);
	}
	return loaded.toSorted((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt)).map((entry) => {
		const repoName = node_path.default.basename(entry.session.cwd);
		return {
			loaded: entry,
			repoName,
			displayLabel: (repoCounts.get(repoName) ?? 0) > 1 ? `${repoName} - ${entry.session.title}` : repoName
		};
	});
}
function transcriptForSession(session) {
	const lines = [
		`# ${session.title}`,
		"",
		`cwd: ${session.cwd}`,
		`session: ${session.sessionId}`,
		`updated: ${session.updatedAt}`,
		""
	];
	for (const message of session.messages) {
		lines.push(`## ${message.role === "user" ? "User" : "Assistant"} - ${message.createdAt}`);
		lines.push("");
		lines.push(message.text);
		lines.push("");
	}
	if (session.activities.length > 0) {
		lines.push("## Tool Calls");
		lines.push("");
		for (const activity of session.activities) {
			lines.push(`### ${activity.summary}`);
			const payload = activity.payload;
			if (payload && typeof payload === "object") {
				const detail = payload.detail;
				if (typeof detail === "string" && detail.trim().length > 0) lines.push(detail);
			}
			lines.push("");
		}
	}
	return lines.join("\n");
}
async function openCandidateInVim(candidate) {
	const tempDir = await node_fs_promises.mkdtemp(node_path.default.join(node_os.default.tmpdir(), "t3r-transcript-"));
	const transcriptPath = node_path.default.join(tempDir, "conversation.md");
	await node_fs_promises.writeFile(transcriptPath, transcriptForSession(candidate.loaded.session), "utf8");
	if (node_process.default.stdin.isTTY) node_process.default.stdin.setRawMode(false);
	node_process.default.stdin.pause();
	node_process.default.stdout.write("\x1B[?25h\x1B[2J\x1B[H");
	await runProcess("vim", [transcriptPath], { stdio: "inherit" }).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
	});
	node_process.default.stdin.resume();
	if (node_process.default.stdin.isTTY) node_process.default.stdin.setRawMode(true);
}
function renderPicker(candidates, selectedIndex) {
	node_process.default.stdout.write("\x1B[2J\x1B[H\x1B[?25l");
	node_process.default.stdout.write("t3r push\n\n");
	node_process.default.stdout.write("Enter selects. Tab opens history in vim. q cancels.\n\n");
	candidates.forEach((candidate, index) => {
		const marker = index === selectedIndex ? ">" : " ";
		const session = candidate.loaded.session;
		node_process.default.stdout.write(`${marker} ${candidate.displayLabel}\n`);
		node_process.default.stdout.write(`  ${session.cwd}\n`);
		node_process.default.stdout.write(`  updated ${session.updatedAt}\n`);
	});
}
async function pickPushCandidate(candidates) {
	if (!node_process.default.stdin.isTTY || !node_process.default.stdout.isTTY) throw new Error("t3r push needs an interactive terminal.");
	let selectedIndex = 0;
	node_readline.emitKeypressEvents(node_process.default.stdin);
	node_process.default.stdin.setRawMode(true);
	node_process.default.stdin.resume();
	try {
		for (;;) {
			renderPicker(candidates, selectedIndex);
			const key = await new Promise((resolve) => {
				node_process.default.stdin.once("keypress", (_str, pressedKey) => resolve(pressedKey));
			});
			if (key.ctrl && key.name === "c") return null;
			if (key.name === "q" || key.name === "escape") return null;
			if (key.name === "up" || key.name === "k") {
				selectedIndex = (selectedIndex - 1 + candidates.length) % candidates.length;
				continue;
			}
			if (key.name === "down" || key.name === "j") {
				selectedIndex = (selectedIndex + 1) % candidates.length;
				continue;
			}
			if (key.name === "tab") {
				await openCandidateInVim(candidates[selectedIndex]);
				continue;
			}
			if (key.name === "return" || key.name === "enter") return candidates[selectedIndex] ?? null;
		}
	} finally {
		node_process.default.stdin.setRawMode(false);
		node_process.default.stdout.write("\x1B[?25h\x1B[2J\x1B[H");
	}
}
async function createPushArchive(candidate) {
	const workspaceRoot = candidate.loaded.session.cwd;
	const tempDir = await node_fs_promises.mkdtemp(node_path.default.join(node_os.default.tmpdir(), "t3r-push-"));
	const metadataRoot = node_path.default.join(tempDir, "metadata");
	const metadataDir = node_path.default.join(metadataRoot, T3R_PUSH_METADATA_DIR);
	const archivePath = node_path.default.join(tempDir, `${candidate.repoName}.tar.gz`);
	await node_fs_promises.mkdir(metadataDir, { recursive: true });
	await node_fs_promises.writeFile(node_path.default.join(metadataDir, "session.jsonl"), candidate.loaded.contents, "utf8");
	await node_fs_promises.writeFile(node_path.default.join(metadataDir, "metadata.json"), JSON.stringify({
		repoName: candidate.repoName,
		sessionId: candidate.loaded.session.sessionId,
		sourceCwd: workspaceRoot,
		createdAt: (/* @__PURE__ */ new Date()).toISOString()
	}, null, 2), "utf8");
	await runProcess("tar", [
		"-czf",
		archivePath,
		"-C",
		workspaceRoot,
		".",
		"-C",
		metadataRoot,
		T3R_PUSH_METADATA_DIR
	]);
	return {
		archivePath,
		tempDir,
		archiveBytes: (await node_fs_promises.stat(archivePath)).size
	};
}
async function pushArchive(input) {
	const response = await fetch(endpointUrl(input.remoteUrl, "/api/t3r/push"), {
		method: "POST",
		headers: {
			authorization: `Bearer ${input.token}`,
			"content-type": "application/gzip",
			"content-length": String(input.archiveBytes),
			"x-t3r-repo-name": encodeURIComponent(input.candidate.repoName),
			"x-t3r-session-id": input.candidate.loaded.session.sessionId
		},
		body: node_fs.createReadStream(input.archivePath),
		duplex: "half"
	});
	if (!response.ok) throw new Error(await readResponseError(response, `t3r push failed with ${response.status}.`));
	return await response.json();
}
async function terminateDaemonProcess(pid, pidPath) {
	node_process.default.kill(pid, "SIGTERM");
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await delay(100);
		if (!isProcessAlive(pid)) {
			await removePidFile(pidPath);
			return true;
		}
	}
	return false;
}
async function startDaemon(paths, remoteUrl, options = {}) {
	const existingPid = await readPid(paths.pidPath);
	if (existingPid && isProcessAlive(existingPid)) if (options.restartIfRunning) {
		console.log(`Restarting t3r with refreshed auth (old pid ${existingPid}).`);
		if (!await terminateDaemonProcess(existingPid, paths.pidPath)) throw new Error(`t3r is still running (pid ${existingPid}). Run 't3r stop' and try again.`);
	} else {
		console.log(`t3r is already running (pid ${existingPid}).`);
		return;
	}
	if (existingPid && !isProcessAlive(existingPid)) await removePidFile(paths.pidPath);
	await node_fs_promises.mkdir(paths.configDir, {
		recursive: true,
		mode: 448
	});
	const logHandle = await node_fs_promises.open(paths.logPath, "a");
	let childPid;
	try {
		const child = (0, node_child_process.spawn)(node_process.default.execPath, [(0, node_url.fileURLToPath)(require("url").pathToFileURL(__filename).href), INTERNAL_DAEMON_COMMAND], {
			cwd: node_process.default.cwd(),
			detached: true,
			env: {
				...node_process.default.env,
				T3R_REMOTE_URL: remoteUrl,
				T3R_TOKEN_FILE: paths.tokenPath,
				T3R_PID_FILE: paths.pidPath,
				T3R_LOG_FILE: paths.logPath,
				T3R_STARTED_CWD: node_process.default.cwd()
			},
			stdio: [
				"ignore",
				logHandle.fd,
				logHandle.fd
			]
		});
		childPid = child.pid;
		child.unref();
	} finally {
		await logHandle.close();
	}
	if (!childPid) throw new Error("Failed to spawn t3r.");
	await node_fs_promises.writeFile(paths.pidPath, `${childPid}\n`, { mode: 384 });
	await delay(750);
	if (!isProcessAlive(childPid)) {
		await removePidFile(paths.pidPath);
		throw new Error(`t3r exited during startup. See ${paths.logPath}`);
	}
	console.log(`t3r started (pid ${childPid}).`);
	console.log(`Remote: ${remoteUrl}`);
	console.log(`Log: ${paths.logPath}`);
}
async function stopDaemon(paths) {
	const pid = await readPid(paths.pidPath);
	if (!pid) {
		console.log("t3r is not running.");
		return;
	}
	if (!isProcessAlive(pid)) {
		await removePidFile(paths.pidPath);
		console.log("t3r was not running. Removed stale pid file.");
		return;
	}
	if (await terminateDaemonProcess(pid, paths.pidPath)) console.log("t3r stopped.");
	else {
		await removePidFile(paths.pidPath);
		console.log("t3r stop requested. Process is still shutting down.");
	}
}
function cleanupPidOnExit(paths) {
	const cleanup = () => {
		try {
			const raw = node_fs.readFileSync(paths.pidPath, "utf8").trim();
			if (Number.parseInt(raw, 10) === node_process.default.pid) node_fs.unlinkSync(paths.pidPath);
		} catch {}
	};
	node_process.default.once("exit", cleanup);
}
function runDaemon() {
	const paths = resolvePaths();
	const remoteUrl = resolveRemoteUrl();
	const cwd = node_process.default.env.T3R_STARTED_CWD?.trim() || node_process.default.cwd();
	cleanupPidOnExit(paths);
	node_process.default.title = "t3r";
	const flags = {
		mode: effect.Option.some("web"),
		port: effect.Option.none(),
		host: effect.Option.some("127.0.0.1"),
		baseDir: effect.Option.none(),
		cwd: effect.Option.some(cwd),
		devUrl: effect.Option.none(),
		noBrowser: effect.Option.some(true),
		bootstrapFd: effect.Option.none(),
		autoBootstrapProjectFromCwd: effect.Option.some(true),
		logWebSocketEvents: effect.Option.none(),
		bridgeUrl: effect.Option.some(remoteUrl),
		bridgeTokenFile: effect.Option.some(paths.tokenPath),
		bridgeBearerToken: effect.Option.none(),
		bridgePairingToken: effect.Option.none()
	};
	const RuntimeLayer = effect.Layer.mergeAll(_effect_platform_node_NodeServices.layer, require_cli.NetService.layer);
	const program = effect.Effect.gen(function* () {
		const config = yield* require_cli.resolveServerConfig(flags, effect.Option.none(), {
			startupPresentation: "headless",
			forceAutoBootstrapProjectFromCwd: true
		});
		return yield* require_cli.runServer.pipe(effect.Effect.provideService(require_cli.ServerConfig, config));
	}).pipe(effect.Effect.scoped, effect.Effect.provide(RuntimeLayer));
	_effect_platform_node_NodeRuntime.runMain(program);
}
async function runPush(paths, remoteUrl) {
	await ensureBridgeToken(remoteUrl, paths);
	const token = await readSavedToken(paths.tokenPath);
	if (!token) throw new Error("t3r auth was not saved.");
	const updatedSinceMs = await resolvePushUpdatedSinceMs(paths);
	const candidates = buildPushCandidates(await require_cli.loadUpdatedCodexCliSessionsFromDisk({
		root: codexSessionsRoot(),
		updatedSinceMs
	})).filter((candidate) => {
		const cwd = candidate.loaded.session.cwd;
		try {
			return candidate.repoName.length > 0 && node_fs.statSync(cwd).isDirectory();
		} catch {
			return false;
		}
	});
	if (candidates.length === 0) {
		console.log("No recent Codex chats found for t3r push.");
		console.log("The picker includes chats updated since 10 minutes before t3r started.");
		return;
	}
	const candidate = await pickPushCandidate(candidates);
	if (candidate === null) {
		console.log("t3r push cancelled.");
		return;
	}
	const workspaceSize = await directorySizeBytes(candidate.loaded.session.cwd);
	if (workspaceSize > ONE_GIB) {
		if (!await confirmPrompt(`Workspace ${candidate.repoName} is ${formatBytes(workspaceSize)} before compression. Continue?`)) {
			console.log("t3r push cancelled.");
			return;
		}
	}
	console.log(`Packaging ${candidate.repoName} from ${candidate.loaded.session.cwd}...`);
	const archive = await createPushArchive(candidate);
	try {
		console.log(`Uploading ${formatBytes(archive.archiveBytes)} to ${remoteUrl}...`);
		const result = await pushArchive({
			remoteUrl,
			token,
			candidate,
			archivePath: archive.archivePath,
			archiveBytes: archive.archiveBytes
		});
		console.log(`Pushed ${String(result.title ?? candidate.loaded.session.title)}.`);
		if (typeof result.workspacePath === "string") console.log(`Workspace: ${result.workspacePath}`);
		if (typeof result.threadId === "string") console.log(`Thread: ${result.threadId}`);
		console.log(`Imported ${Number(result.messageCount ?? candidate.loaded.session.messages.length)} messages and ${Number(result.activityCount ?? candidate.loaded.session.activities.length)} tool calls.`);
	} finally {
		await node_fs_promises.rm(archive.tempDir, {
			recursive: true,
			force: true
		}).catch(() => void 0);
	}
}
async function main() {
	const command = node_process.default.argv[2]?.trim();
	const paths = resolvePaths();
	if (command === INTERNAL_DAEMON_COMMAND) {
		runDaemon();
		return;
	}
	if (command === "stop") {
		await stopDaemon(paths);
		return;
	}
	const remoteUrl = resolveRemoteUrl();
	if (command === "push") {
		await runPush(paths, remoteUrl);
		return;
	}
	if (command && command !== "start") {
		console.error("Usage: t3r");
		console.error("       t3r stop");
		console.error("       t3r push");
		node_process.default.exitCode = 1;
		return;
	}
	await startDaemon(paths, remoteUrl, { restartIfRunning: (await ensureBridgeToken(remoteUrl, paths)).refreshed });
}
main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	node_process.default.exitCode = 1;
});

//#endregion
//# sourceMappingURL=t3r.cjs.map