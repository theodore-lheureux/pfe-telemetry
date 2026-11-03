import { readDatabaseConfig } from "../src/db/config.server";
import { applyMigrations } from "./migrations";

try {
	const config = readDatabaseConfig();
	await applyMigrations(config.connectionString);
	console.info("Application database migrations applied");
} catch {
	console.error(
		"Application database migration failed. Check DATABASE_URL, database access and migration SQL.",
	);
	process.exitCode = 1;
}
