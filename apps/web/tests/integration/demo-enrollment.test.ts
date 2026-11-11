import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { applyMigrations } from "../../scripts/migrations";
import { provisionDemoCollectors } from "../../scripts/provision-demo-collectors";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Disposable TEST_DATABASE_URL is required");

test("local demo enrollment reuses canonical ownership and tokens, and refuses lost-token replacement", async () => {
	const name = `recount_demo_enroll_${randomUUID().replaceAll("-", "")}`;
	const admin = new Pool({ connectionString: databaseUrl, max: 1 });
	const directory = await mkdtemp(join(tmpdir(), "recount-demo-enrollment-"));
	try {
		await admin.query(`CREATE DATABASE "${name}"`);
		const url = new URL(databaseUrl);
		url.pathname = `/${name}`;
		await applyMigrations(url.toString());
		const input = {
			email: "owner@example.invalid",
			organizationName: "Recount demo",
			organizationSlug: "recount-demo",
			projectName: "Local VMs",
			stateDirectory: directory,
			nodes: [
				{ name: "node1", hostId: "recount-compute-1" },
				{ name: "node2", hostId: "recount-compute-2" },
			],
			databaseUrl: url.toString(),
			origin: "http://localhost:36551",
			authSecret: randomUUID(),
		};
		const first = await provisionDemoCollectors(input);
		expect(first.changed).toBe(true);
		expect(first.nodes.map((node) => node.hostId)).toEqual([
			"recount-compute-1",
			"recount-compute-2",
		]);
		const key = await readFile(join(directory, "enrollment.key"), "utf8");
		expect((await stat(join(directory, "enrollment.key"))).mode & 0o777).toBe(
			0o600,
		);
		const second = await provisionDemoCollectors(input);
		expect(second.changed).toBe(false);
		expect(second.projectId).toBe(first.projectId);
		expect(second.organizationId).toBe(first.organizationId);
		expect(second.nodes).toEqual(first.nodes);
		expect(await readFile(join(directory, "enrollment.key"), "utf8")).toBe(key);
		expect(JSON.stringify(second)).not.toContain(key.trim());
		await unlink(join(directory, "enrollment.key"));
		await expect(provisionDemoCollectors(input)).rejects.toThrow(
			"enrollment key file is missing",
		);
		const inspect = new Pool({ connectionString: url.toString(), max: 1 });
		try {
			const [counts] = (
				await inspect.query(`SELECT
				(SELECT count(*)::int FROM ingestion.enrollment_key) AS keys,
				(SELECT count(*)::int FROM app.organization) AS organizations,
				(SELECT count(*)::int FROM app.member WHERE role = 'owner') AS owners`)
			).rows;
			expect(counts).toEqual({ keys: 1, organizations: 1, owners: 1 });
		} finally {
			await inspect.end();
		}
	} finally {
		await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
		await admin.end();
		await rm(directory, { recursive: true, force: true });
	}
});
