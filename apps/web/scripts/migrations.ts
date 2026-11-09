import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

export const migrationsFolder = fileURLToPath(
	new URL("../drizzle/", import.meta.url),
);

export async function applyMigrations(
	connectionString: string,
	folder = migrationsFolder,
) {
	const pool = new Pool({
		connectionString,
		max: 1,
		connectionTimeoutMillis: 5_000,
		statement_timeout: 60_000,
		lock_timeout: 10_000,
		application_name: "recount-migrations",
	});
	try {
		const client = await pool.connect();
		try {
			// Serialize migration jobs on the same physical session used by Drizzle.
			// Closing the session releases the lock on both success and failure.
			await client.query("SELECT pg_advisory_lock($1, $2)", [0x504645, 0x4442]);
			await migrate(drizzle({ client }), { migrationsFolder: folder });
		} finally {
			client.release(true);
		}
	} finally {
		await pool.end();
	}
}
