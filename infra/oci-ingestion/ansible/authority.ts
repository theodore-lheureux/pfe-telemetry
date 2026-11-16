import { readFileSync } from "node:fs";

function compose(args: string[], input?: string, environment = {}) {
	const result = Bun.spawnSync(["docker", "compose", ...args], {
		stdin: input === undefined ? "ignore" : Buffer.from(input),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...environment },
	});
	if (!result.success)
		throw new Error("Backend authority preparation failed; inspect privately");
	return result.stdout.toString();
}

const config = JSON.parse(compose(["config", "--format", "json"]));
const web = config.services.web.environment;
const ingestion = config.services["ingestion-api"].environment;
if (process.argv[2] !== "--verify") {
	const runner = "/opt/recount/bootstrap/migrations.mjs";
	const { applyMigrations } = await import(runner);
	const password = config.services.postgres.environment.POSTGRES_PASSWORD;
	await applyMigrations(
		`postgresql://recount:${password}@127.0.0.1:15432/recount`,
		"/opt/recount/bootstrap/apps/web/drizzle",
	);
}
for (const [file, key, url, role] of [
	["web-role.sql", "RECOUNT_WEB_PASSWORD", web.DATABASE_URL, "recount_web"],
	[
		"ingestion-role.sql",
		"RECOUNT_INGESTION_PASSWORD",
		ingestion.RECOUNT_INGESTION_DATABASE_URL,
		"recount_ingestion",
	],
]) {
	if (process.argv[2] === "--verify") {
		const privileges =
			role === "recount_web"
				? "has_table_privilege(current_user, 'app.organization', 'SELECT,INSERT,UPDATE,DELETE')"
				: "has_column_privilege(current_user, 'ingestion.collector_node', 'revoked_at', 'SELECT') AND NOT has_schema_privilege(current_user, 'app', 'USAGE')";
		const result = compose(
			[
				"exec",
				"-T",
				"--env",
				"PGPASSWORD",
				"postgres",
				"psql",
				"--host=127.0.0.1",
				`--username=${role}`,
				"--dbname=recount",
				"--tuples-only",
				"--no-align",
				"--command",
				`SELECT (${privileges}) AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AND NOT has_schema_privilege(current_user, 'app', 'CREATE') AND NOT has_schema_privilege(current_user, 'drizzle', 'USAGE') FROM pg_roles WHERE rolname = current_user`,
			],
			undefined,
			{ PGPASSWORD: new URL(url).password },
		);
		if (result.trim() !== "t")
			throw new Error("Runtime database role permissions are incorrect");
		continue;
	}
	compose(
		[
			"exec",
			"-T",
			"--env",
			key,
			"postgres",
			"psql",
			"--username=recount",
			"--dbname=recount",
		],
		readFileSync(`/opt/recount/bootstrap/${file}`, "utf8"),
		{ [key]: new URL(url).password },
	);
}
