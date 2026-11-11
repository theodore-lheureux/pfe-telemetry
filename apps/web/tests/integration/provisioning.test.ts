import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { createTestDatabase } from "../database";

test("shipped ingestion grants are repeatable, SELECT-only and deny unrelated authority", async () => {
	const database = await createTestDatabase("provisioning");
	const role = `recount_tooling_${randomUUID().replaceAll("-", "")}`;
	const password = randomUUID();
	let created = false;
	let reader: Pool | undefined;
	let roleClient: PoolClient | undefined;
	try {
		const source = await readFile(
			new URL("../../../../infra/local/ingestion-role.sql", import.meta.url),
			"utf8",
		);
		// Only the role identifier is scoped; psql executes the shipped grants unchanged.
		const script = source.replaceAll("recount_ingestion", role);
		async function provision() {
			const connection = new URL(database.url);
			const adminPassword =
				connection.searchParams.get("password") ??
				decodeURIComponent(connection.password);
			connection.password = "";
			connection.searchParams.delete("password");
			const process = Bun.spawn(
				["psql", "--no-psqlrc", "--dbname", connection.toString()],
				{
					env: {
						PATH: Bun.env.PATH,
						PGPASSWORD: adminPassword,
						PGPASSFILE: "/dev/null",
						PGCONNECT_TIMEOUT: "5",
						RECOUNT_INGESTION_PASSWORD: password,
					},
					stdin: new TextEncoder().encode(script),
					stdout: "pipe",
					stderr: "pipe",
					timeout: 10_000,
				},
			);
			const [code, _output, error] = await Promise.all([
				process.exited,
				new Response(process.stdout).text(),
				new Response(process.stderr).text(),
			]);
			created = true;
			expect(code, error).toBe(0);
		}
		await provision();
		await database.pool.query(
			`GRANT USAGE ON SCHEMA app TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA app TO ${role}; GRANT CREATE ON SCHEMA ingestion TO ${role}`,
		);
		await provision();
		await database.pool.query(`
			INSERT INTO app.organization (id,name,slug,created_at) VALUES ('test-org','Test','test',now());
			INSERT INTO app.project (id,organization_id,name) VALUES ('019a4790-d1da-7000-8000-000000000002','test-org','Test');
			INSERT INTO ingestion.enrollment_key (id,organization_id,project_id,name,key_sha256)
			VALUES ('019a4790-d1da-7000-8000-000000000001','test-org','019a4790-d1da-7000-8000-000000000002','Test',repeat('a',64));
			INSERT INTO ingestion.collector_node (id,organization_id,project_id,enrollment_key_id,machine_id,hostname,public_key,revoked_at)
			VALUES ('019a4790-d1da-7000-8000-000000000003','test-org','019a4790-d1da-7000-8000-000000000002','019a4790-d1da-7000-8000-000000000001','node1','node1',repeat('A',43),now());
		`);
		const url = new URL(database.url);
		url.username = role;
		url.password = password;
		reader = new Pool({ connectionString: url.toString(), max: 1 });
		// Keep the session setting across expected query errors; pool.query can replace its client.
		roleClient = await reader.connect();
		expect(
			(
				await roleClient.query(
					"SELECT id FROM ingestion.collector_node WHERE revoked_at IS NOT NULL",
				)
			).rows,
		).toEqual([{ id: "019a4790-d1da-7000-8000-000000000003" }]);
		expect(
			(
				await roleClient.query(
					"SELECT has_schema_privilege(current_user,'app','USAGE') AS app, has_schema_privilege(current_user,'ingestion','CREATE') AS create",
				)
			).rows,
		).toEqual([{ app: false, create: false }]);
		await roleClient.query("SET default_transaction_read_only=off");
		expect((await roleClient.query("SHOW transaction_read_only")).rows).toEqual(
			[{ transaction_read_only: "off" }],
		);
		for (const query of [
			'SELECT * FROM app."user"',
			"SELECT * FROM app.session",
			"SELECT * FROM app.project",
			"SELECT public_key FROM ingestion.collector_node",
			"SELECT * FROM ingestion.collector_node",
			"SELECT * FROM ingestion.enrollment_key",
			"UPDATE ingestion.collector_node SET revoked_at=NULL",
			"DELETE FROM ingestion.collector_node",
			"CREATE TABLE ingestion.denied (id integer)",
		])
			await expect(roleClient.query(query)).rejects.toMatchObject({
				code: "42501",
			});
	} finally {
		roleClient?.release();
		await reader?.end();
		try {
			if (
				created &&
				(
					await database.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
						role,
					])
				).rowCount
			)
				await database.pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
		} finally {
			await database.close();
		}
	}
});
