export interface DatabaseConfig {
	connectionString: string;
	max: number;
}

export function readDatabaseConfig(
	env: Record<string, string | undefined> = process.env,
): DatabaseConfig {
	const connectionString = env.DATABASE_URL;
	if (!connectionString) {
		throw new Error("DATABASE_URL is required");
	}

	let url: URL;
	try {
		url = new URL(connectionString);
	} catch {
		throw new Error("DATABASE_URL must be a PostgreSQL connection URL");
	}
	if (
		!["postgres:", "postgresql:"].includes(url.protocol) ||
		!url.hostname ||
		url.pathname.length < 2
	) {
		throw new Error("DATABASE_URL must include a PostgreSQL host and database");
	}

	const poolSize = env.DATABASE_POOL_MAX ?? "10";
	if (!/^[1-9]\d*$/.test(poolSize) || Number(poolSize) > 100) {
		throw new Error("DATABASE_POOL_MAX must be an integer from 1 to 100");
	}
	return { connectionString, max: Number(poolSize) };
}
