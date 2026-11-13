import * as z from "zod";
import { type Env, integer, readEnv } from "../lib/env.server";

function postgresUrl(value: string) {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return (
		["postgres:", "postgresql:"].includes(url.protocol) &&
		Boolean(url.hostname) &&
		url.pathname.length > 1
	);
}

const settings = z.object({
	DATABASE_URL: z
		.string({ error: "DATABASE_URL is required" })
		.refine(postgresUrl, "DATABASE_URL must be a PostgreSQL connection URL"),
	RECOUNT_DATABASE_POOL_MAX: integer(
		"RECOUNT_DATABASE_POOL_MAX",
		1,
		100,
	).default(10),
});

export interface DatabaseConfig {
	connectionString: string;
	max: number;
}

export function readDatabaseConfig(env: Env = process.env): DatabaseConfig {
	const parsed = readEnv(settings, env);
	return {
		connectionString: parsed.DATABASE_URL,
		max: parsed.RECOUNT_DATABASE_POOL_MAX,
	};
}
