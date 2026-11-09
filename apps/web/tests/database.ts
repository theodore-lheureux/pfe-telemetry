import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { applyMigrations } from "../scripts/migrations";
import { createDatabase } from "../src/db/client.server";

export async function createTestDatabase(prefix: string, max = 4) {
	if (!/^[a-z_]{1,14}$/.test(prefix))
		throw new Error("Invalid test database prefix");
	const adminUrl = process.env.TEST_DATABASE_URL;
	if (!adminUrl) throw new Error("TEST_DATABASE_URL is required");
	const admin = new Pool({
		connectionString: adminUrl,
		max: 1,
		connectionTimeoutMillis: 5_000,
	});
	const name = `recount_tooling_${prefix}_${randomUUID().replaceAll("-", "")}`;
	const url = new URL(adminUrl);
	url.pathname = `/${name}`;
	let created = false;
	let database: ReturnType<typeof createDatabase> | undefined;
	async function close() {
		try {
			await database?.pool.end();
		} finally {
			try {
				if (created) {
					await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
					created = false;
				}
			} finally {
				await admin.end();
			}
		}
	}
	try {
		await admin.query(`CREATE DATABASE "${name}"`);
		created = true;
		await applyMigrations(url.toString());
		database = createDatabase({ connectionString: url.toString(), max });
		return { ...database, url: url.toString(), close };
	} catch (error) {
		await close();
		throw error;
	}
}
