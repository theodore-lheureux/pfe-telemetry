import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { type DatabaseConfig, readDatabaseConfig } from "./config.server";
import * as schema from "./schema";

export function createDatabase(config: DatabaseConfig) {
	const pool = new Pool({
		connectionString: config.connectionString,
		max: config.max,
		connectionTimeoutMillis: 5_000,
		idleTimeoutMillis: 30_000,
		statement_timeout: 15_000,
		application_name: "recount-web",
	});
	// Idle-client errors otherwise become unhandled EventEmitter errors. Do not
	// log driver errors: they can contain connection or query details.
	pool.on("error", () =>
		console.error("Application database connection failed"),
	);
	return { pool, db: drizzle({ client: pool, schema }) };
}

type Database = ReturnType<typeof createDatabase>;
// Keep the pool across development module reloads.
const runtime = globalThis as typeof globalThis & {
	recountApplicationDatabase?: Database;
};

export function getDatabase() {
	runtime.recountApplicationDatabase ??= createDatabase(readDatabaseConfig());
	return runtime.recountApplicationDatabase.db;
}

export async function closeDatabase() {
	const database = runtime.recountApplicationDatabase;
	delete runtime.recountApplicationDatabase;
	await database?.pool.end();
}
