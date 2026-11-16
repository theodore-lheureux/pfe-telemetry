import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { applyMigrations } from "../../scripts/migrations";
import { provisionCollectorProject } from "../../scripts/provision-collector-project";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Disposable TEST_DATABASE_URL is required");

test("operator provisioning preserves unverified accounts, canonical ownership and once-revealed keys", async () => {
	const name = `recount_collector_project_${randomUUID().replaceAll("-", "")}`;
	const admin = new Pool({ connectionString: databaseUrl, max: 1 });
	const directory = await mkdtemp(join(tmpdir(), "recount-collector-project-"));
	let inspect: Pool | undefined;
	try {
		await admin.query(`CREATE DATABASE "${name}"`);
		const url = new URL(databaseUrl);
		url.pathname = `/${name}`;
		await applyMigrations(url.toString());
		const input = {
			email: "owner@example.invalid",
			organizationName: "Owner organization",
			organizationSlug: "owner",
			projectName: "AWS collectors",
			stateDirectory: directory,
			databaseUrl: url.toString(),
			origin: "https://app.example.test",
			authSecret: randomUUID(),
		};
		const first = await provisionCollectorProject(input);
		expect(first.changed).toBe(true);
		const key = await readFile(join(directory, "enrollment.key"), "utf8");
		const second = await provisionCollectorProject(input);
		expect(second).toEqual({ ...first, changed: false });
		expect(JSON.stringify(second)).not.toContain(key.trim());
		inspect = new Pool({ connectionString: url.toString(), max: 1 });
		const { rows } = await inspect.query(`SELECT
			(SELECT bool_and(NOT email_verified) FROM app."user") AS unverified,
			(SELECT count(*)::int FROM app.session) AS sessions,
			(SELECT count(*)::int FROM app.member WHERE role = 'owner') AS owners,
			(SELECT owner_count FROM app.organization_owner_guard) AS guarded_owners,
			(SELECT count(*)::int FROM app.project) AS projects,
			(SELECT count(*)::int FROM ingestion.enrollment_key) AS keys`);
		expect(rows[0]).toEqual({
			unverified: true,
			sessions: 0,
			owners: 1,
			guarded_owners: 1,
			projects: 1,
			keys: 1,
		});
		await unlink(join(directory, "enrollment.key"));
		await expect(provisionCollectorProject(input)).rejects.toThrow(
			"Restore the existing enrollment key",
		);
	} finally {
		await inspect?.end();
		await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
		await admin.end();
		await rm(directory, { recursive: true, force: true });
	}
});
