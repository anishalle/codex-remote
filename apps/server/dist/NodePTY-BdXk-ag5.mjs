#!/usr/bin/env node

import { n as PtySpawnError, t as PtyAdapter } from "./PTY-CihSwCdI.mjs";
import { createRequire } from "node:module";
import { Effect, FileSystem, Layer, Path } from "effect";

//#region src/terminal/Layers/NodePTY.ts
let didEnsureSpawnHelperExecutable = false;
const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
	const requireForNodePty = createRequire(import.meta.url);
	const path = yield* Path.Path;
	const fs = yield* FileSystem.FileSystem;
	const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
	const packageDir = path.dirname(packageJsonPath);
	const candidates = [
		path.join(packageDir, "build", "Release", "spawn-helper"),
		path.join(packageDir, "build", "Debug", "spawn-helper"),
		path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")
	];
	for (const candidate of candidates) if (yield* fs.exists(candidate)) return candidate;
	return null;
}).pipe(Effect.orElseSucceed(() => null));
const ensureNodePtySpawnHelperExecutable = Effect.fn(function* (explicitPath) {
	const fs = yield* FileSystem.FileSystem;
	if (process.platform === "win32") return;
	if (!explicitPath && didEnsureSpawnHelperExecutable) return;
	const helperPath = explicitPath ?? (yield* resolveNodePtySpawnHelperPath);
	if (!helperPath) return;
	if (!explicitPath) didEnsureSpawnHelperExecutable = true;
	if (!(yield* fs.exists(helperPath))) return;
	yield* fs.chmod(helperPath, 493).pipe(Effect.orElseSucceed(() => void 0));
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
const layer = Layer.effect(PtyAdapter, Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const nodePty = yield* Effect.promise(() => import("node-pty"));
	const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(ensureNodePtySpawnHelperExecutable().pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path), Effect.orElseSucceed(() => void 0)));
	return { spawn: Effect.fn(function* (input) {
		yield* ensureNodePtySpawnHelperExecutableCached;
		return new NodePtyProcess(yield* Effect.try({
			try: () => nodePty.spawn(input.shell, input.args ?? [], {
				cwd: input.cwd,
				cols: input.cols,
				rows: input.rows,
				env: input.env,
				name: globalThis.process.platform === "win32" ? "xterm-color" : "xterm-256color"
			}),
			catch: (cause) => new PtySpawnError({
				adapter: "node-pty",
				message: cause instanceof Error ? cause.message : "Failed to spawn PTY process",
				cause
			})
		}));
	}) };
}));

//#endregion
export { ensureNodePtySpawnHelperExecutable, layer };
//# sourceMappingURL=NodePTY-BdXk-ag5.mjs.map