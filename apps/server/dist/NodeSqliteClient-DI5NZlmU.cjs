#!/usr/bin/env node

const require_chunk = require('./chunk-DlKPiV2v.cjs');
let effect_Effect = require("effect/Effect");
effect_Effect = require_chunk.__toESM(effect_Effect);
let effect_Layer = require("effect/Layer");
effect_Layer = require_chunk.__toESM(effect_Layer);
let effect_Function = require("effect/Function");
let effect_Semaphore = require("effect/Semaphore");
effect_Semaphore = require_chunk.__toESM(effect_Semaphore);
let effect_unstable_sql_SqlClient = require("effect/unstable/sql/SqlClient");
effect_unstable_sql_SqlClient = require_chunk.__toESM(effect_unstable_sql_SqlClient);
let effect_Context = require("effect/Context");
effect_Context = require_chunk.__toESM(effect_Context);
let effect_Scope = require("effect/Scope");
effect_Scope = require_chunk.__toESM(effect_Scope);
let effect_Stream = require("effect/Stream");
effect_Stream = require_chunk.__toESM(effect_Stream);
let node_sqlite = require("node:sqlite");
let effect_Cache = require("effect/Cache");
effect_Cache = require_chunk.__toESM(effect_Cache);
let effect_Config = require("effect/Config");
effect_Config = require_chunk.__toESM(effect_Config);
let effect_Duration = require("effect/Duration");
effect_Duration = require_chunk.__toESM(effect_Duration);
let effect_Fiber = require("effect/Fiber");
effect_Fiber = require_chunk.__toESM(effect_Fiber);
let effect_unstable_reactivity_Reactivity = require("effect/unstable/reactivity/Reactivity");
effect_unstable_reactivity_Reactivity = require_chunk.__toESM(effect_unstable_reactivity_Reactivity);
let effect_unstable_sql_SqlError = require("effect/unstable/sql/SqlError");
let effect_unstable_sql_Statement = require("effect/unstable/sql/Statement");
effect_unstable_sql_Statement = require_chunk.__toESM(effect_unstable_sql_Statement);

//#region src/persistence/NodeSqliteClient.ts
/**
* Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
* bindings instead of `better-sqlite3`.
*
* @module SqliteClient
*/
const ATTR_DB_SYSTEM_NAME = "db.system.name";
const TypeId = "~local/sqlite-node/SqliteClient";
/**
* SqliteClient - Effect service tag for the sqlite SQL client.
*/
const SqliteClient = effect_Context.Service("t3/persistence/NodeSqliteClient");
/**
* Verify that the current Node.js version includes the `node:sqlite` APIs
* used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
* in Node 22.16.0 / 23.11.0).
*
* @see https://github.com/nodejs/node/pull/57490
*/
const checkNodeSqliteCompat = () => {
	const parts = process.versions.node.split(".").map(Number);
	const major = parts[0] ?? 0;
	const minor = parts[1] ?? 0;
	if (!(major === 22 && minor >= 16 || major === 23 && minor >= 11 || major >= 24)) return effect_Effect.die(`Node.js ${process.versions.node} is missing required node:sqlite APIs (StatementSync.columns). Upgrade to Node.js >=22.16, >=23.11, or >=24.`);
	return effect_Effect.void;
};
const makeWithDatabase = effect_Effect.fn("makeWithDatabase")(function* (options, openDatabase) {
	yield* checkNodeSqliteCompat();
	const compiler = effect_unstable_sql_Statement.makeCompilerSqlite(options.transformQueryNames);
	const transformRows = options.transformResultNames ? effect_unstable_sql_Statement.defaultTransforms(options.transformResultNames).array : void 0;
	const makeConnection = effect_Effect.gen(function* () {
		const scope = yield* effect_Effect.scope;
		const db = openDatabase();
		yield* effect_Scope.addFinalizer(scope, effect_Effect.sync(() => db.close()));
		const statementReaderCache = /* @__PURE__ */ new WeakMap();
		const hasRows = (statement) => {
			const cached = statementReaderCache.get(statement);
			if (cached !== void 0) return cached;
			const value = statement.columns().length > 0;
			statementReaderCache.set(statement, value);
			return value;
		};
		const prepareCache = yield* effect_Cache.make({
			capacity: options.prepareCacheSize ?? 200,
			timeToLive: options.prepareCacheTTL ?? effect_Duration.minutes(10),
			lookup: (sql) => effect_Effect.try({
				try: () => db.prepare(sql),
				catch: (cause) => new effect_unstable_sql_SqlError.SqlError({ reason: (0, effect_unstable_sql_SqlError.classifySqliteError)(cause, {
					message: "Failed to prepare statement",
					operation: "prepare"
				}) })
			})
		});
		const runStatement = (statement, params, raw) => effect_Effect.withFiber((fiber) => {
			statement.setReadBigInts(Boolean(effect_Context.get(fiber.context, effect_unstable_sql_SqlClient.SafeIntegers)));
			try {
				if (hasRows(statement)) return effect_Effect.succeed(statement.all(...params));
				const result = statement.run(...params);
				return effect_Effect.succeed(raw ? result : []);
			} catch (cause) {
				return effect_Effect.fail(new effect_unstable_sql_SqlError.SqlError({ reason: (0, effect_unstable_sql_SqlError.classifySqliteError)(cause, {
					message: "Failed to execute statement",
					operation: "execute"
				}) }));
			}
		});
		const run = (sql, params, raw = false) => effect_Effect.flatMap(effect_Cache.get(prepareCache, sql), (s) => runStatement(s, params, raw));
		const runValues = (sql, params) => effect_Effect.acquireUseRelease(effect_Cache.get(prepareCache, sql), (statement) => effect_Effect.try({
			try: () => {
				if (hasRows(statement)) {
					statement.setReturnArrays(true);
					return statement.all(...params);
				}
				statement.run(...params);
				return [];
			},
			catch: (cause) => new effect_unstable_sql_SqlError.SqlError({ reason: (0, effect_unstable_sql_SqlError.classifySqliteError)(cause, {
				message: "Failed to execute statement",
				operation: "execute"
			}) })
		}), (statement) => effect_Effect.sync(() => {
			if (hasRows(statement)) statement.setReturnArrays(false);
		}));
		return (0, effect_Function.identity)({
			execute(sql, params, rowTransform) {
				return rowTransform ? effect_Effect.map(run(sql, params), rowTransform) : run(sql, params);
			},
			executeRaw(sql, params) {
				return run(sql, params, true);
			},
			executeValues(sql, params) {
				return runValues(sql, params);
			},
			executeUnprepared(sql, params, rowTransform) {
				const effect = runStatement(db.prepare(sql), params ?? [], false);
				return rowTransform ? effect_Effect.map(effect, rowTransform) : effect;
			},
			executeStream(_sql, _params) {
				return effect_Stream.die("executeStream not implemented");
			}
		});
	});
	const semaphore = yield* effect_Semaphore.make(1);
	const connection = yield* makeConnection;
	const acquirer = semaphore.withPermits(1)(effect_Effect.succeed(connection));
	const transactionAcquirer = effect_Effect.uninterruptibleMask((restore) => {
		const fiber = effect_Fiber.getCurrent();
		const scope = effect_Context.getUnsafe(fiber.context, effect_Scope.Scope);
		return effect_Effect.as(effect_Effect.tap(restore(semaphore.take(1)), () => effect_Scope.addFinalizer(scope, semaphore.release(1))), connection);
	});
	return yield* effect_unstable_sql_SqlClient.make({
		acquirer,
		compiler,
		transactionAcquirer,
		spanAttributes: [...options.spanAttributes ? Object.entries(options.spanAttributes) : [], [ATTR_DB_SYSTEM_NAME, "sqlite"]],
		transformRows
	});
});
const make = (options) => makeWithDatabase(options, () => new node_sqlite.DatabaseSync(options.filename, {
	readOnly: options.readonly ?? false,
	allowExtension: options.allowExtension ?? false
}));
const makeMemory = (config = {}) => makeWithDatabase({
	...config,
	filename: ":memory:",
	readonly: false
}, () => {
	return new node_sqlite.DatabaseSync(":memory:", { allowExtension: config.allowExtension ?? false });
});
const layerConfig = (config) => effect_Layer.effectContext(effect_Config.unwrap(config).asEffect().pipe(effect_Effect.flatMap(make), effect_Effect.map((client) => effect_Context.make(SqliteClient, client).pipe(effect_Context.add(effect_unstable_sql_SqlClient.SqlClient, client))))).pipe(effect_Layer.provide(effect_unstable_reactivity_Reactivity.layer));
const layer = (config) => effect_Layer.effectContext(effect_Effect.map(make(config), (client) => effect_Context.make(SqliteClient, client).pipe(effect_Context.add(effect_unstable_sql_SqlClient.SqlClient, client)))).pipe(effect_Layer.provide(effect_unstable_reactivity_Reactivity.layer));
const layerMemory = (config = {}) => effect_Layer.effectContext(effect_Effect.map(makeMemory(config), (client) => effect_Context.make(SqliteClient, client).pipe(effect_Context.add(effect_unstable_sql_SqlClient.SqlClient, client)))).pipe(effect_Layer.provide(effect_unstable_reactivity_Reactivity.layer));

//#endregion
exports.SqliteClient = SqliteClient;
exports.TypeId = TypeId;
exports.layer = layer;
exports.layerConfig = layerConfig;
exports.layerMemory = layerMemory;
//# sourceMappingURL=NodeSqliteClient-DI5NZlmU.cjs.map