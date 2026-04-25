#!/usr/bin/env node

const require_chunk = require('./chunk-DlKPiV2v.cjs');
const require_cli = require('./cli-BuwSNSrQ.cjs');
require('./PTY-BNE-GnF4.cjs');
let _effect_platform_node_NodeRuntime = require("@effect/platform-node/NodeRuntime");
_effect_platform_node_NodeRuntime = require_chunk.__toESM(_effect_platform_node_NodeRuntime);
let _effect_platform_node_NodeServices = require("@effect/platform-node/NodeServices");
_effect_platform_node_NodeServices = require_chunk.__toESM(_effect_platform_node_NodeServices);
let effect_Effect = require("effect/Effect");
effect_Effect = require_chunk.__toESM(effect_Effect);
let effect_Layer = require("effect/Layer");
effect_Layer = require_chunk.__toESM(effect_Layer);
let effect_unstable_cli = require("effect/unstable/cli");

//#region src/bin.ts
const CliRuntimeLayer = effect_Layer.mergeAll(_effect_platform_node_NodeServices.layer, require_cli.NetService.layer);
effect_unstable_cli.Command.run(require_cli.cli, { version: require_cli.version }).pipe(effect_Effect.scoped, effect_Effect.provide(CliRuntimeLayer), _effect_platform_node_NodeRuntime.runMain);

//#endregion
//# sourceMappingURL=bin.cjs.map