import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createEnrollmentKey } from "../../apps/web/src/collectors/collectors.server";
import { createDatabase } from "../../apps/web/src/db/client.server";
import { user } from "../../apps/web/src/db/schema";
import { cleanup, endpoint, loopback, type Run, required } from "./run";

const DEFAULT_PROJECT = "9c708f11-695b-4a15-959e-15a916eeefaf";

async function binary() {
	if (process.env.RECOUNT_LOADGEN_BIN)
		return resolve(process.env.RECOUNT_LOADGEN_BIN);
	const build = Bun.spawn(
		[
			"cargo",
			"build",
			"--locked",
			"--release",
			"-p",
			"recount-collector",
			"--example",
			"loadgen",
			"--message-format=json",
		],
		{ stdout: "pipe", stderr: "inherit" },
	);
	const messages = await new Response(build.stdout).text();
	if (await build.exited) throw new Error("Native load generator build failed");
	for (const line of messages.trim().split("\n")) {
		const item = JSON.parse(line);
		if (
			item.reason === "compiler-artifact" &&
			item.target?.name === "loadgen" &&
			item.executable
		)
			return item.executable as string;
	}
	throw new Error("Cannot resolve the loadgen executable");
}

async function main() {
	const counts = (process.env.RECOUNT_LOADGEN_STAGES ?? "20").split(",");
	const stages = counts.map(Number);
	if (
		stages.some(
			(n, i) =>
				!Number.isInteger(n) ||
				n < 1 ||
				n > 1500 ||
				(i > 0 && n <= stages[i - 1]),
		)
	)
		throw new Error(
			"RECOUNT_LOADGEN_STAGES must be increasing integers from 1 through 1500",
		);
	const seconds = Number(process.env.RECOUNT_LOADGEN_SECONDS ?? 60);
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)
		throw new Error("RECOUNT_LOADGEN_SECONDS must be between 1 and 86400");
	const web = endpoint("RECOUNT_LOAD_WEB_ORIGIN");
	const otlp = endpoint("RECOUNT_LOAD_OTLP_ORIGIN");
	const dbUrl = new URL(required("RECOUNT_LOAD_DATABASE_URL"));
	if (!loopback(dbUrl))
		throw new Error(
			"Use a loopback application DB endpoint or operator tunnel",
		);
	const executable = await binary();
	const organizationId = required("RECOUNT_LOAD_ORGANIZATION_ID");
	const projectId = process.env.RECOUNT_LOAD_PROJECT_ID ?? DEFAULT_PROJECT;
	const email = required("RECOUNT_LOAD_OPERATOR_EMAIL").trim().toLowerCase();
	const runId = crypto.randomUUID();
	const directory = resolve(".state/load", runId);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const database = createDatabase({ connectionString: dbUrl.href, max: 2 });
	const keyPath = resolve(directory, "enrollment.key");
	const nodeDirectory = resolve(directory, "nodes");
	let manifest: Run | undefined;
	try {
		const [actor] = await database.db
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, email));
		if (!actor) throw new Error("The operator account must already exist");
		const key = await createEnrollmentKey(database.db, actor, {
			projectId,
			organizationId,
			name: `Native load ${runId}`,
			adapter: "linux",
			maxNodes: stages.at(-1),
			labels: ["load-test"],
			expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
		});
		manifest = {
			projectId,
			organizationId,
			actorId: actor.id,
			enrollmentKeyId: key.enrollmentKey.id,
		};
		const manifestPath = resolve(directory, "run.json");
		await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
		console.error(`Project ${projectId}; cleanup manifest ${manifestPath}`);
		await writeFile(keyPath, key.key, { mode: 0o600 });
		const child = Bun.spawn(
			[
				executable,
				"--stages",
				stages.join(","),
				"--seconds",
				String(seconds),
				"--endpoint",
				otlp.origin,
				"--enrollment-url",
				web.origin,
				"--enrollment-key-file",
				keyPath,
				"--state-directory",
				nodeDirectory,
				"--project",
				projectId,
				"--run",
				runId,
				...(process.env.RECOUNT_LOAD_ALLOW_REMOTE === "1"
					? ["--allow-remote"]
					: []),
			],
			{
				env: { PATH: process.env.PATH, HOME: process.env.HOME },
				stdout: "inherit",
				stderr: "inherit",
			},
		);
		const stop = () => child.kill("SIGTERM");
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
		try {
			process.exitCode = await child.exited;
		} finally {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
		}
	} finally {
		await unlink(keyPath).catch(() => {});
		try {
			if (manifest) await cleanup(database.db, manifest);
		} finally {
			await database.pool.end();
			await rm(nodeDirectory, { recursive: true, force: true });
		}
	}
}

try {
	await main();
} catch (error) {
	console.error(
		error instanceof Error && !("query" in error) && !("code" in error)
			? error.message
			: "Load generator failed; inspect the local run state",
	);
	process.exitCode = 1;
}
