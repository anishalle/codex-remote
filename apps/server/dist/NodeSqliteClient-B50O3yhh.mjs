#!/usr/bin/env node

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { identity } from "effect/Function";
import * as Semaphore from "effect/Semaphore";
import * as Client from "effect/unstable/sql/SqlClient";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { DatabaseSync } from "node:sqlite";
import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

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
const SqliteClient = Context.Service("t3/persistence/NodeSqliteClient");
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
	if (!(major === 22 && minor >= 16 || major === 23 && minor >= 11 || major >= 24)) return Effect.die(`Node.js ${process.versions.node} is missing required node:sqlite APIs (StatementSync.columns). Upgrade to Node.js >=22.16, >=23.11, or >=24.`);
	return Effect.void;
};
const makeWithDatabase = Effect.fn("makeWithDatabase")(function* (options, openDatabase) {
	yield* checkNodeSqliteCompat();
	const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
	const transformRows = options.transformResultNames ? Statement.defaultTransforms(options.transformResultNames).array : void 0;
	const makeConnection = Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const db = openDatabase();
		yield* Scope.addFinalizer(scope, Effect.sync(() => db.close()));
		const statementReaderCache = /* @__PURE__ */ new WeakMap();
		const hasRows = (statement) => {
			const cached = statementReaderCache.get(statement);
			if (cached !== void 0) return cached;
			const value = statement.columns().length > 0;
			statementReaderCache.set(statement, value);
			return value;
		};
		const prepareCache = yield* Cache.make({
			capacity: options.prepareCacheSize ?? 200,
			timeToLive: options.prepareCacheTTL ?? Duration.minutes(10),
			lookup: (sql) => Effect.try({
				try: () => db.prepare(sql),
				catch: (cause) => new SqlError({ reason: classifySqliteError(cause, {
					message: "Failed to prepare statement",
					operation: "prepare"
				}) })
			})
		});
		const runStatement = (statement, params, raw) => Effect.withFiber((fiber) => {
			statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
			try {
				if (hasRows(statement)) return Effect.succeed(statement.all(...params));
				const result = statement.run(...params);
				return Effect.succeed(raw ? result : []);
			} catch (cause) {
				return Effect.fail(new SqlError({ reason: classifySqliteError(cause, {
					message: "Failed to execute statement",
					operation: "execute"
				}) }));
			}
		});
		const run = (sql, params, raw = false) => Effect.flatMap(Cache.get(prepareCache, sql), (s) => runStatement(s, params, raw));
		const runValues = (sql, params) => Effect.acquireUseRelease(Cache.get(prepareCache, sql), (statement) => Effect.try({
			try: () => {
				if (hasRows(statement)) {
					statement.setReturnArrays(true);
					return statement.all(...params);
				}
				statement.run(...params);
				return [];
			},
			catch: (cause) => new SqlError({ reason: classifySqliteError(cause, {
				message: "Failed to execute statement",
				operation: "execute"
			}) })
		}), (statement) => Effect.sync(() => {
			if (hasRows(statement)) statement.setReturnArrays(false);
		}));
		return identity({
			execute(sql, params, rowTransform) {
				return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
			},
			executeRaw(sql, params) {
				return run(sql, params, true);
			},
			executeValues(sql, params) {
				return runValues(sql, params);
			},
			executeUnprepared(sql, params, rowTransform) {
				const effect = runStatement(db.prepare(sql), params ?? [], false);
				return rowTransform ? Effect.map(effect, rowTransform) : effect;
			},
			executeStream(_sql, _params) {
				return Stream.die("executeStream not implemented");
			}
		});
	});
	const semaphore = yield* Semaphore.make(1);
	const connection = yield* makeConnection;
	const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
	const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
		const fiber = Fiber.getCurrent();
		const scope = Context.getUnsafe(fiber.context, Scope.Scope);
		return Effect.as(Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))), connection);
	});
	return yield* Client.make({
		acquirer,
		compiler,
		transactionAcquirer,
		spanAttributes: [...options.spanAttributes ? Object.entries(options.spanAttributes) : [], [ATTR_DB_SYSTEM_NAME, "sqlite"]],
		transformRows
	});
});
const make = (options) => makeWithDatabase(options, () => new DatabaseSync(options.filename, {
	readOnly: options.readonly ?? false,
	allowExtension: options.allowExtension ?? false
}));
const makeMemory = (config = {}) => makeWithDatabase({
	...config,
	filename: ":memory:",
	readonly: false
}, () => {
	return new DatabaseSync(":memory:", { allowExtension: config.allowExtension ?? false });
});
const layerConfig = (config) => Layer.effectContext(Config.unwrap(config).asEffect().pipe(Effect.flatMap(make), Effect.map((client) => Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client))))).pipe(Layer.provide(Reactivity.layer));
const layer = (config) => Layer.effectContext(Effect.map(make(config), (client) => Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)))).pipe(Layer.provide(Reactivity.layer));
const layerMemory = (config = {}) => Layer.effectContext(Effect.map(makeMemory(config), (client) => Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)))).pipe(Layer.provide(Reactivity.layer));

//#endregion
export { SqliteClient, TypeId, layer, layerConfig, layerMemory };
//# sourceMappingURL=NodeSqliteClient-B50O3yhh.mjs.map