#!/usr/bin/env node

const require_chunk = require('./chunk-DlKPiV2v.cjs');
const require_PTY = require('./PTY-BNE-GnF4.cjs');
let effect = require("effect");
let node_module = require("node:module");

//#region src/terminal/Layers/NodePTY.ts
let didEnsureSpawnHelperExecutable = false;
const resolveNodePtySpawnHelperPath = effect.Effect.gen(function* () {
	const requireForNodePty = (0, node_module.createRequire)(require("url").pathToFileURL(__filename).href);
	const path = yield* effect.Path.Path;
	const fs = yield* effect.FileSystem.FileSystem;
	const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
	const packageDir = path.dirname(packageJsonPath);
	const candidates = [
		path.join(packageDir, "build", "Release", "spawn-helper"),
		path.join(packageDir, "build", "Debug", "spawn-helper"),
		path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")
	];
	for (const candidate of candidates) if (yield* fs.exists(candidate)) return candidate;
	return null;
}).pipe(effect.Effect.orElseSucceed(() => null));
const ensureNodePtySpawnHelperExecutable = effect.Effect.fn(function* (explicitPath) {
	const fs = yield* effect.FileSystem.FileSystem;
	if (process.platform === "win32") return;
	if (!explicitPath && didEnsureSpawnHelperExecutable) return;
	const helperPath = explicitPath ?? (yield* resolveNodePtySpawnHelperPath);
	if (!helperPath) return;
	if (!explicitPath) didEnsureSpawnHelperExecutable = true;
	if (!(yield* fs.exists(helperPath))) return;
	yield* fs.chmod(helperPath, 493).pipe(effect.Effect.orElseSucceed(() => void 0));
});
var NodePtyProcess = class {
	process;
	constructor(process) {
		this.process = process;
	}
	get pid() {
		return this.process.pid;
	}
	write(data) {
		this.process.write(data);
	}
	resize(cols, rows) {
		this.process.resize(cols, rows);
	}
	kill(signal) {
		this.process.kill(signal);
	}
	onData(callback) {
		const disposable = this.process.onData(callback);
		return () => {
			disposable.dispose();
		};
	}
	onExit(callback) {
		const disposable = this.process.onExit((event) => {
			callback({
				exitCode: event.exitCode,
				signal: event.signal ?? null
			});
		});
		return () => {
			disposable.dispose();
		};
	}
};
const layer = effect.Layer.effect(require_PTY.PtyAdapter, effect.Effect.gen(function* () {
	const fs = yield* effect.FileSystem.FileSystem;
	const path = yield* effect.Path.Path;
	const nodePty = yield* effect.Effect.promise(() => import("node-pty"));
	const ensureNodePtySpawnHelperExecutableCached = yield* effect.Effect.cached(ensureNodePtySpawnHelperExecutable().pipe(effect.Effect.provideService(effect.FileSystem.FileSystem, fs), effect.Effect.provideService(effect.Path.Path, path), effect.Effect.orElseSucceed(() => void 0)));
	return { spawn: effect.Effect.fn(function* (input) {
		yield* ensureNodePtySpawnHelperExecutableCached;
		return new NodePtyProcess(yield* effect.Effect.try({
			try: () => nodePty.spawn(input.shell, input.args ?? [], {
				cwd: input.cwd,
				cols: input.cols,
				rows: input.rows,
				env: input.env,
				name: globalThis.process.platform === "win32" ? "xterm-color" : "xterm-256color"
			}),
			catch: (cause) => new require_PTY.PtySpawnError({
				adapter: "node-pty",
				message: cause instanceof Error ? cause.message : "Failed to spawn PTY process",
				cause
			})
		}));
	}) };
}));

//#endregion
exports.ensureNodePtySpawnHelperExecutable = ensureNodePtySpawnHelperExecutable;
exports.layer = layer;
//# sourceMappingURL=NodePTY-C7SzG9yf.cjs.map