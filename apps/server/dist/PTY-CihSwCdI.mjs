#!/usr/bin/env node

import { Context, Effect, Schema } from "effect";

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
var PtySpawnError = class extends Schema.TaggedErrorClass()("PtySpawnError", {
	adapter: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect)
}) {};
/**
* PtyAdapter - Service tag for PTY process integration.
*/
var PtyAdapter = class extends Context.Service()("t3/terminal/Services/PTY/PtyAdapter") {};

//#endregion
export { PtySpawnError as n, PtyAdapter as t };
//# sourceMappingURL=PTY-CihSwCdI.mjs.map