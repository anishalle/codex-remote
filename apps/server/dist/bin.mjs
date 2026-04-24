#!/usr/bin/env node

import { a as version, s as NetService, t as cli } from "./cli-Bl4SUpNY.mjs";
import "./PTY-CihSwCdI.mjs";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

//#region src/bin.ts
const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
Command.run(cli, { version }).pipe(Effect.scoped, Effect.provide(CliRuntimeLayer), NodeRuntime.runMain);

//#endregion
export {  };
//# sourceMappingURL=bin.mjs.map