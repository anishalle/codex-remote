#!/usr/bin/env node

const require_chunk = require('./chunk-DlKPiV2v.cjs');
const require_PTY = require('./PTY-BNE-GnF4.cjs');
let effect = require("effect");

//#region src/terminal/Layers/BunPTY.ts
var BunPtyProcess = class {
	dataListeners = /* @__PURE__ */ new Set();
	exitListeners = /* @__PURE__ */ new Set();
	decoder = new TextDecoder();
	process;
	didExit = false;
	constructor(process) {
		this.process = process;
		this.process.exited.then((exitCode) => {
			this.emitExit({
				exitCode: Number.isInteger(exitCode) ? exitCode : 0,
				signal: typeof this.process.signalCode === "number" ? this.process.signalCode : null
			});
		}).catch(() => {
			this.emitExit({
				exitCode: 1,
				signal: null
			});
		});
	}
	get pid() {
		return this.process.pid;
	}
	write(data) {
		if (!this.process.terminal) throw new Error("Bun PTY terminal handle is unavailable");
		this.process.terminal.write(data);
	}
	resize(cols, rows) {
		if (!this.process.terminal?.resize) throw new Error("Bun PTY resize is unavailable");
		this.process.terminal.resize(cols, rows);
	}
	kill(signal) {
		if (!signal) {
			this.process.kill();
			return;
		}
		this.process.kill(signal);
	}
	onData(callback) {
		this.dataListeners.add(callback);
		return () => {
			this.dataListeners.delete(callback);
		};
	}
	onExit(callback) {
		this.exitListeners.add(callback);
		return () => {
			this.exitListeners.delete(callback);
		};
	}
	emitData(data) {
		if (this.didExit) return;
		const text = this.decoder.decode(data, { stream: true });
		if (text.length === 0) return;
		for (const listener of this.dataListeners) listener(text);
	}
	emitExit(event) {
		if (this.didExit) return;
		this.didExit = true;
		const remainder = this.decoder.decode();
		if (remainder.length > 0) for (const listener of this.dataListeners) listener(remainder);
		for (const listener of this.exitListeners) listener(event);
	}
};
const layer = effect.Layer.effect(require_PTY.PtyAdapter, effect.Effect.gen(function* () {
	if (process.platform === "win32") return yield* effect.Effect.die("Bun PTY terminal support is unavailable on Windows. Please use Node.js (e.g. by running `npx t3`) instead.");
	return { spawn: (input) => effect.Effect.sync(() => {
		let processHandle = null;
		const command = [input.shell, ...input.args ?? []];
		processHandle = new BunPtyProcess(Bun.spawn(command, {
			cwd: input.cwd,
			env: input.env,
			terminal: {
				cols: input.cols,
				rows: input.rows,
				data: (_terminal, data) => {
					processHandle?.emitData(data);
				}
			}
		}));
		return processHandle;
	}) };
}));

//#endregion
exports.layer = layer;
//# sourceMappingURL=BunPTY-DCkAHiv0.cjs.map