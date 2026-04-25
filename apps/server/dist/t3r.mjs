#!/usr/bin/env node

import { i as loadUpdatedCodexCliSessionsFromDisk, n as resolveServerConfig, o as ServerConfig, r as runServer, s as NetService } from "./cli-BIDXo99N.mjs";
import "./PTY-CihSwCdI.mjs";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option } from "effect";
import * as fsSync from "node:fs";
import * as readline from "node:readline";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import * as path$1 from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs$1 from "node:fs/promises";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import process from "node:process";

//#region src/t3rPush/archive.ts
function execFileBuffer(command, args, cwd) {
	return new Promise((resolve, reject) => {
		execFile(command, [...args], {
			cwd,
			encoding: "buffer",
			maxBuffer: 64 * 1024 * 1024
		}, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(Buffer.from(stderr).toString("utf8") || error.message));
				return;
			}
			resolve(Buffer.from(stdout));
		});
	});
}
async function pathExists(targetPath) {
	try {
		await stat(targetPath);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
function normalizeArchiveEntries(entries) {
	const unique = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		if (entry.length === 0) continue;
		if (entry.includes("\0") || entry.includes("\n") || entry.includes("\r")) throw new Error(`t3r push cannot archive a path containing control separators: ${JSON.stringify(entry)}`);
		unique.add(entry);
	}
	return [...unique];
}
async function collectGitArchiveEntries(workspaceRoot) {
	const entries = (await execFileBuffer("git", [
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard"
	], workspaceRoot)).toString("utf8").split("\0").filter((entry) => entry.length > 0);
	return normalizeArchiveEntries(await pathExists(path$1.join(workspaceRoot, ".git")) ? [".git", ...entries] : entries);
}
async function collectWorkspaceArchiveEntries(workspaceRoot) {
	try {
		return await collectGitArchiveEntries(workspaceRoot);
	} catch {
		return ["."];
	}
}
function serializeWorkspaceArchiveEntries(entries) {
	const normalized = normalizeArchiveEntries(entries);
	return normalized.length > 0 ? `${normalized.join("\n")}\n` : "";
}

//#endregion
//#region src/t3r.ts
const DEFAULT_REMOTE_URL = "https://codex.anishalle.com";
const INTERNAL_DAEMON_COMMAND = "__daemon";
const PUSH_LOOKBACK_MS = 10 * 6e4;
const ONE_GIB = 1024 * 1024 * 1024;
const T3R_PUSH_METADATA_DIR = ".t3r-push";
function resolveConfigDir() {
	const configured = process.env.T3R_CONFIG_DIR?.trim();
	if (configured) return path.resolve(configured.replace(/^~(?=$|\/)/, os.homedir()));
	const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
	const root = xdgConfigHome ? path.resolve(xdgConfigHome) : path.join(os.homedir(), ".config");
	return path.join(root, "t3r");
}
function resolveRemoteUrl() {
	const configured = process.env.T3R_REMOTE_URL?.trim();
	return new URL(configured || DEFAULT_REMOTE_URL).toString();
}
function resolvePaths() {
	const configDir = resolveConfigDir();
	return {
		configDir,
		tokenPath: process.env.T3R_TOKEN_FILE?.trim() || path.join(configDir, "token"),
		pidPath: process.env.T3R_PID_FILE?.trim() || path.join(configDir, "t3r.pid"),
		logPath: process.env.T3R_LOG_FILE?.trim() || path.join(configDir, "t3r.log")
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
		const token = (await fs$1.readFile(tokenPath, "utf8")).trim();
		return token.length > 0 ? token : null;
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
async function writeSavedToken(tokenPath, token) {
	await fs$1.mkdir(path.dirname(tokenPath), {
		recursive: true,
		mode: 448
	});
	await fs$1.writeFile(tokenPath, `${token.trim()}\n`, { mode: 384 });
	await fs$1.chmod(tokenPath, 384).catch(() => void 0);
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
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("t3r needs a pairing link or token the first time. Run it in an interactive terminal.");
	console.log(`t3r needs auth for ${remoteUrl}`);
	console.log("Create a pairing link in T3, then paste the full link or token here.");
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout
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
	await fs$1.mkdir(paths.configDir, {
		recursive: true,
		mode: 448
	});
	await fs$1.chmod(paths.configDir, 448).catch(() => void 0);
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
		const raw = (await fs$1.readFile(pidPath, "utf8")).trim();
		const pid = Number.parseInt(raw, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
async function removePidFile(pidPath) {
	await fs$1.unlink(pidPath).catch((error) => {
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
		const child = spawn(command, args, {
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
		execFile(command, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
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
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout
	});
	try {
		const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}
function codexSessionsRoot() {
	const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
	return path.join(codexHome, "sessions");
}
async function resolvePushUpdatedSinceMs(paths) {
	const pid = await readPid(paths.pidPath);
	if (pid && isProcessAlive(pid)) try {
		return (await fs$1.stat(paths.pidPath)).mtimeMs - PUSH_LOOKBACK_MS;
	} catch {
		return Date.now() - PUSH_LOOKBACK_MS;
	}
	return Date.now() - PUSH_LOOKBACK_MS;
}
function buildPushCandidates(loaded) {
	const repoCounts = /* @__PURE__ */ new Map();
	for (const entry of loaded) {
		const repoName = path.basename(entry.session.cwd);
		repoCounts.set(repoName, (repoCounts.get(repoName) ?? 0) + 1);
	}
	return loaded.toSorted((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt)).map((entry) => {
		const repoName = path.basename(entry.session.cwd);
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
	const tempDir = await fs$1.mkdtemp(path.join(os.tmpdir(), "t3r-transcript-"));
	const transcriptPath = path.join(tempDir, "conversation.md");
	await fs$1.writeFile(transcriptPath, transcriptForSession(candidate.loaded.session), "utf8");
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	process.stdin.pause();
	process.stdout.write("\x1B[?25h\x1B[2J\x1B[H");
	await runProcess("vim", [transcriptPath], { stdio: "inherit" }).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
	});
	process.stdin.resume();
	if (process.stdin.isTTY) process.stdin.setRawMode(true);
}
function renderPicker(candidates, selectedIndex) {
	process.stdout.write("\x1B[2J\x1B[H\x1B[?25l");
	process.stdout.write("t3r push\n\n");
	process.stdout.write("Enter selects. Tab opens history in vim. q cancels.\n\n");
	candidates.forEach((candidate, index) => {
		const marker = index === selectedIndex ? ">" : " ";
		const session = candidate.loaded.session;
		process.stdout.write(`${marker} ${candidate.displayLabel}\n`);
		process.stdout.write(`  ${session.cwd}\n`);
		process.stdout.write(`  updated ${session.updatedAt}\n`);
	});
}
async function pickPushCandidate(candidates) {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("t3r push needs an interactive terminal.");
	let selectedIndex = 0;
	readline.emitKeypressEvents(process.stdin);
	process.stdin.setRawMode(true);
	process.stdin.resume();
	try {
		for (;;) {
			renderPicker(candidates, selectedIndex);
			const key = await new Promise((resolve) => {
				process.stdin.once("keypress", (_str, pressedKey) => resolve(pressedKey));
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
		process.stdin.setRawMode(false);
		process.stdout.write("\x1B[?25h\x1B[2J\x1B[H");
	}
}
async function createPushArchive(candidate) {
	const workspaceRoot = candidate.loaded.session.cwd;
	const tempDir = await fs$1.mkdtemp(path.join(os.tmpdir(), "t3r-push-"));
	const metadataRoot = path.join(tempDir, "metadata");
	const metadataDir = path.join(metadataRoot, T3R_PUSH_METADATA_DIR);
	const archiveEntriesPath = path.join(tempDir, "archive-entries.txt");
	const archivePath = path.join(tempDir, `${candidate.repoName}.tar.gz`);
	await fs$1.mkdir(metadataDir, { recursive: true });
	await fs$1.writeFile(path.join(metadataDir, "session.jsonl"), candidate.loaded.contents, "utf8");
	await fs$1.writeFile(path.join(metadataDir, "metadata.json"), JSON.stringify({
		repoName: candidate.repoName,
		sessionId: candidate.loaded.session.sessionId,
		sourceCwd: workspaceRoot,
		createdAt: (/* @__PURE__ */ new Date()).toISOString()
	}, null, 2), "utf8");
	const archiveEntries = await collectWorkspaceArchiveEntries(workspaceRoot);
	await fs$1.writeFile(archiveEntriesPath, serializeWorkspaceArchiveEntries(archiveEntries), "utf8");
	await runProcess("tar", [
		"-czf",
		archivePath,
		"-C",
		workspaceRoot,
		"-T",
		archiveEntriesPath,
		"-C",
		metadataRoot,
		T3R_PUSH_METADATA_DIR
	]);
	return {
		archivePath,
		tempDir,
		archiveBytes: (await fs$1.stat(archivePath)).size
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
		body: fsSync.createReadStream(input.archivePath),
		duplex: "half"
	});
	if (!response.ok) throw new Error(await readResponseError(response, `t3r push failed with ${response.status}.`));
	return await response.json();
}
async function terminateDaemonProcess(pid, pidPath) {
	process.kill(pid, "SIGTERM");
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
	await fs$1.mkdir(paths.configDir, {
		recursive: true,
		mode: 448
	});
	const logHandle = await fs$1.open(paths.logPath, "a");
	let childPid;
	try {
		const child = spawn(process.execPath, [fileURLToPath(import.meta.url), INTERNAL_DAEMON_COMMAND], {
			cwd: process.cwd(),
			detached: true,
			env: {
				...process.env,
				T3R_REMOTE_URL: remoteUrl,
				T3R_TOKEN_FILE: paths.tokenPath,
				T3R_PID_FILE: paths.pidPath,
				T3R_LOG_FILE: paths.logPath,
				T3R_STARTED_CWD: process.cwd()
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
	await fs$1.writeFile(paths.pidPath, `${childPid}\n`, { mode: 384 });
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
			const raw = fsSync.readFileSync(paths.pidPath, "utf8").trim();
			if (Number.parseInt(raw, 10) === process.pid) fsSync.unlinkSync(paths.pidPath);
		} catch {}
	};
	process.once("exit", cleanup);
}
function runDaemon() {
	const paths = resolvePaths();
	const remoteUrl = resolveRemoteUrl();
	const cwd = process.env.T3R_STARTED_CWD?.trim() || process.cwd();
	cleanupPidOnExit(paths);
	process.title = "t3r";
	const flags = {
		mode: Option.some("web"),
		port: Option.none(),
		host: Option.some("127.0.0.1"),
		baseDir: Option.none(),
		cwd: Option.some(cwd),
		devUrl: Option.none(),
		noBrowser: Option.some(true),
		bootstrapFd: Option.none(),
		autoBootstrapProjectFromCwd: Option.some(false),
		logWebSocketEvents: Option.none(),
		bridgeUrl: Option.some(remoteUrl),
		bridgeTokenFile: Option.some(paths.tokenPath),
		bridgeBearerToken: Option.none(),
		bridgePairingToken: Option.none()
	};
	const RuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
	const program = Effect.gen(function* () {
		const config = yield* resolveServerConfig(flags, Option.none(), {
			startupPresentation: "headless",
			forceAutoBootstrapProjectFromCwd: true
		});
		return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
	}).pipe(Effect.scoped, Effect.provide(RuntimeLayer));
	NodeRuntime.runMain(program);
}
async function runPush(paths, remoteUrl) {
	await ensureBridgeToken(remoteUrl, paths);
	const token = await readSavedToken(paths.tokenPath);
	if (!token) throw new Error("t3r auth was not saved.");
	const updatedSinceMs = await resolvePushUpdatedSinceMs(paths);
	const candidates = buildPushCandidates(await loadUpdatedCodexCliSessionsFromDisk({
		root: codexSessionsRoot(),
		updatedSinceMs
	})).filter((candidate) => {
		const cwd = candidate.loaded.session.cwd;
		try {
			return candidate.repoName.length > 0 && fsSync.statSync(cwd).isDirectory();
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
		await fs$1.rm(archive.tempDir, {
			recursive: true,
			force: true
		}).catch(() => void 0);
	}
}
async function main() {
	const command = process.argv[2]?.trim();
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
		process.exitCode = 1;
		return;
	}
	await startDaemon(paths, remoteUrl, { restartIfRunning: (await ensureBridgeToken(remoteUrl, paths)).refreshed });
}
main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

//#endregion
export {  };
//# sourceMappingURL=t3r.mjs.map