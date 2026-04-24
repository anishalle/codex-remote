#!/usr/bin/env node

const require_chunk = require('./chunk-DlKPiV2v.cjs');
let effect = require("effect");

//#region src/terminal/Services/PTY.ts
/**
* PtyAdapter - Terminal PTY adapter service contract.
*
* Defines the process primitives required by terminal session management
* without binding to a specific PTY implementation.
*
* @module PtyAdapter
*/
/**
* PtyError - Error type for PTY adapter operations.
*/
var PtySpawnError = class extends effect.Schema.TaggedErrorClass()("PtySpawnError", {
	adapter: effect.Schema.String,
	message: effect.Schema.String,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
/**
* PtyAdapter - Service tag for PTY process integration.
*/
var PtyAdapter = class extends effect.Context.Service()("t3/terminal/Services/PTY/PtyAdapter") {};

//#endregion
Object.defineProperty(exports, 'PtyAdapter', {
  enumerable: true,
  get: function () {
    return PtyAdapter;
  }
});
Object.defineProperty(exports, 'PtySpawnError', {
  enumerable: true,
  get: function () {
    return PtySpawnError;
  }
});
//# sourceMappingURL=PTY-BNE-GnF4.cjs.map