import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

test("normal startup refuses missing, partial and wrong Kafka identities; initialization is explicit and empty-only", async () => {
	const directory = await mkdtemp(join(tmpdir(), "recount-tooling-data-"));
	directories.push(directory);
	const command = [
		"sh",
		new URL("../../infra/local/data-entrypoint.sh", import.meta.url).pathname,
		"kafka",
		"printf",
		"server-started",
	];
	const env = {
		PATH: process.env.PATH,
		KAFKA_LOG_DIRS: directory,
		RECOUNT_DATA_ID: "expected",
	};
	const run = (initialize = false) =>
		Bun.spawnSync(command, {
			env: {
				...env,
				...(initialize ? { RECOUNT_INITIALIZE_ROLE: "kafka" } : {}),
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: 5_000,
		});
	expect(run().exitCode).not.toBe(0);
	expect(run().stdout.toString()).not.toContain("server-started");
	expect(run(true).stdout.toString()).toBe("server-started");
	await writeFile(join(directory, "partial"), "not initialized");
	expect(run(true).exitCode).not.toBe(0);
	await rm(join(directory, "partial"));
	await writeFile(
		join(directory, "meta.properties"),
		"cluster.id=wrong\nnode.id=1\n",
	);
	expect(run(true).exitCode).not.toBe(0);
	await mkdir(join(directory, "__cluster_metadata-0"));
	await writeFile(
		join(directory, "__cluster_metadata-0/000.log"),
		"synthetic content",
	);
	expect(run().exitCode).not.toBe(0);
	await writeFile(
		join(directory, "meta.properties"),
		"cluster.id=expected\nnode.id=2\n",
	);
	expect(run().exitCode).not.toBe(0);
	await writeFile(
		join(directory, "meta.properties"),
		"cluster.id=expected\nnode.id=1\n",
	);
	expect(run().stdout.toString()).toBe("server-started");
	await rm(join(directory, "__cluster_metadata-0/000.log"));
	expect(run().exitCode).not.toBe(0);
});
