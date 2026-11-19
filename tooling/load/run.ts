import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import {
	createEnrollmentKey,
	revokeEnrollmentKey,
	revokeNodes,
} from "../../apps/web/src/collectors/collectors.server";
import { MAX_NODES_PER_REQUEST } from "../../apps/web/src/collectors/contracts";
import { createDatabase } from "../../apps/web/src/db/client.server";
import { collectorNode, user } from "../../apps/web/src/db/schema";
import { createProject } from "../../apps/web/src/organizations/projects.server";

const env = process.env;
function required(name: string) {
	const value = env[name];
	if (!value) throw new Error(`Set ${name}`);
	return value;
}
function integer(name: string, fallback: number, min: number, max: number) {
	const value = Number(env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw new Error(`${name} must be an integer from ${min} to ${max}`);
	return value;
}
const loopback = (url: URL) =>
	["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
function endpoint(name: string) {
	const url = new URL(required(name));
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && loopback(url))) ||
		(!loopback(url) && env.RECOUNT_LOAD_ALLOW_REMOTE !== "1")
	)
		throw new Error(
			`${name} requires an explicit origin; remote load requires HTTPS and RECOUNT_LOAD_ALLOW_REMOTE=1`,
		);
	return url;
}
type Run = {
	organizationId: string;
	projectId: string;
	enrollmentKeyId: string;
	actorId: string;
};

async function main() {
	const url = new URL(required("RECOUNT_LOAD_DATABASE_URL"));
	if (!loopback(url))
		throw new Error(
			"Use a loopback application DB endpoint or operator tunnel",
		);
	const database = createDatabase({ connectionString: url.href, max: 2 });
	try {
		const cleanPath =
			process.argv[2] === "cleanup" ? process.argv[3] : undefined;
		if (process.argv.length > 2) {
			if (!cleanPath || process.argv.length !== 4)
				throw new Error("Usage: run.ts [cleanup run.json]");
			await cleanup(database.db, JSON.parse(await readFile(cleanPath, "utf8")));
			return;
		}
		await run(database.db);
	} finally {
		await database.pool.end();
	}
}

type Database = ReturnType<typeof createDatabase>["db"];
async function cleanup(database: Database, run: Run) {
	const { actorId, projectId, organizationId, enrollmentKeyId } = run;
	const reference = { projectId, organizationId };
	const actor = { id: actorId };
	await revokeEnrollmentKey(database, actor, { ...reference, enrollmentKeyId });
	const nodes = await database
		.select({ id: collectorNode.id })
		.from(collectorNode)
		.where(
			and(
				eq(collectorNode.projectId, projectId),
				eq(collectorNode.organizationId, organizationId),
				eq(collectorNode.enrollmentKeyId, enrollmentKeyId),
			),
		);
	for (let i = 0; i < nodes.length; i += MAX_NODES_PER_REQUEST) {
		await revokeNodes(database, actor, {
			...reference,
			nodeIds: nodes.slice(i, i + MAX_NODES_PER_REQUEST).map(({ id }) => id),
		});
	}
	console.info(
		`Revoked enrollment key and ${nodes.length} nodes in ${projectId}`,
	);
}

function settings() {
	const origin = endpoint("RECOUNT_LOAD_WEB_ORIGIN");
	const otlp = endpoint("RECOUNT_LOAD_OTLP_ORIGIN");
	const mode = env.RECOUNT_LOAD_MODE ?? "regression";
	const fixture = env.RECOUNT_LOAD_FIXTURE ?? "processes";
	if (
		!["regression", "saturation"].includes(mode) ||
		!["idle", "processes"].includes(fixture)
	)
		throw new Error(
			"Choose regression or saturation mode, and idle or processes fixture",
		);
	return {
		origin: origin.origin,
		target: `${otlp.hostname}:${otlp.port || (otlp.protocol === "https:" ? 443 : 80)}`,
		plaintext: otlp.protocol === "http:",
		mode,
		fixture,
		nodes: integer("RECOUNT_LOAD_NODES", 2, 1, 500),
		ramp: `${integer("RECOUNT_LOAD_RAMP_SECONDS", 10, 1, 3600)}s`,
		hold: `${integer("RECOUNT_LOAD_HOLD_SECONDS", 60, 3, 86400)}s`,
		refreshMs: integer("RECOUNT_LOAD_REFRESH_SECONDS", 3300, 1, 3300) * 1000,
		p95Ms: integer("RECOUNT_LOAD_P95_MS", 1000, 1, 3000),
	};
}

async function run(database: Database) {
	const config = settings();
	const executable = Bun.which(env.RECOUNT_LOAD_K6 ?? "k6");
	if (!executable) throw new Error("Install k6 2.4 or set RECOUNT_LOAD_K6");
	const organizationId = required("RECOUNT_LOAD_ORGANIZATION_ID");
	const [owner] = await database
		.select({ id: user.id })
		.from(user)
		.where(
			eq(
				user.email,
				required("RECOUNT_LOAD_OPERATOR_EMAIL").trim().toLowerCase(),
			),
		);
	if (!owner) throw new Error("The operator account must already exist");
	const runId = crypto.randomUUID();
	const directory = resolve(".state/load", runId);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const descriptor = resolve(directory, "otlp.pb");
	if (env.RECOUNT_LOAD_DESCRIPTOR)
		await writeFile(descriptor, await readFile(env.RECOUNT_LOAD_DESCRIPTOR), {
			mode: 0o600,
		});
	else {
		const build = Bun.spawn(
			[
				"cargo",
				"run",
				"--quiet",
				"--locked",
				"-p",
				"recount-telemetry-schema",
				"--example",
				"recount-web-schema-export",
				"--",
				directory,
			],
			{ stderr: "inherit" },
		);
		if (await build.exited)
			throw new Error("OTLP descriptor generation failed");
	}
	const project = await createProject(database, owner, {
		requestId: runId,
		organizationId,
		name: `Load ${runId}`,
	});
	const projectId = project.id;
	const key = await createEnrollmentKey(database, owner, {
		projectId,
		organizationId,
		name: "Load test",
		adapter: "linux",
		maxNodes: config.nodes * (config.mode === "saturation" ? 3 : 1),
		labels: ["load-test"],
		expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
	});
	const manifest: Run = {
		projectId,
		organizationId,
		enrollmentKeyId: key.enrollmentKey.id,
		actorId: owner.id,
	};
	const manifestPath = resolve(directory, "run.json");
	const configPath = resolve(directory, "config.json");
	try {
		await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
		console.info(`Project ${projectId}; cleanup manifest ${manifestPath}`);
		await writeFile(
			configPath,
			JSON.stringify({
				...config,
				descriptor,
				runId,
				projectId,
				enrollmentKey: key.key,
			}),
			{ mode: 0o600 },
		);
		const child = Bun.spawn(
			[
				executable,
				"run",
				"--no-color",
				"--out",
				`json=${resolve(directory, "metrics.json.gz")}`,
				resolve(import.meta.dir, "replay.js"),
			],
			{
				env: {
					PATH: env.PATH,
					HOME: env.HOME,
					RECOUNT_LOAD_CONFIG: configPath,
				},
				stdout: "inherit",
				stderr: "inherit",
			},
		);
		const stop = () => child.kill("SIGINT");
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
		try {
			process.exitCode = await child.exited;
		} finally {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
		}
	} finally {
		await unlink(configPath).catch(() => {});
		await cleanup(database, manifest);
	}
}

try {
	await main();
} catch (error) {
	console.error(
		error instanceof Error && !("query" in error) && !("code" in error)
			? error.message
			: "Load test failed; inspect the local run state",
	);
	process.exitCode = 1;
}
