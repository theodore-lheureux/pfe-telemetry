import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { applyMigrations, migrationsFolder } from "../../scripts/migrations";
import { createDatabase } from "../../src/db/client.server";
import { user } from "../../src/db/schema";

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) {
	throw new Error(
		"TEST_DATABASE_URL is required; database tests create and drop isolated test databases",
	);
}
const admin = new Pool({
	connectionString: adminUrl,
	max: 1,
	connectionTimeoutMillis: 5_000,
});
let name: string;
let connectionString: string;
let pools: Pool[];
let folders: string[];

beforeEach(async () => {
	name = `pfe_test_${randomUUID().replaceAll("-", "")}`;
	pools = [];
	folders = [];
	await admin.query(`CREATE DATABASE "${name}"`);
	const url = new URL(adminUrl);
	url.pathname = `/${name}`;
	connectionString = url.toString();
});

afterEach(async () => {
	await Promise.all(pools.map((pool) => pool.end()));
	await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
	await Promise.all(folders.map((folder) => rm(folder, { recursive: true })));
});

afterAll(async () => {
	await admin.end();
});

function database() {
	const database = createDatabase({ connectionString, max: 1 });
	pools.push(database.pool);
	return database;
}

async function withNextMigration(statement: string) {
	const folder = await mkdtemp(join(tmpdir(), "pfe-migrations-"));
	folders.push(folder);
	await cp(migrationsFolder, folder, { recursive: true });
	const journalPath = join(folder, "meta/_journal.json");
	const journal = JSON.parse(await readFile(journalPath, "utf8"));
	const previous = journal.entries.at(-1);
	const tag = "9999_test_migration";
	journal.entries.push({
		idx: journal.entries.length,
		version: journal.version,
		when: previous.when + 1,
		tag,
		breakpoints: true,
	});
	await writeFile(journalPath, JSON.stringify(journal));
	await writeFile(join(folder, `${tag}.sql`), statement);
	return folder;
}

describe("application database", () => {
	test("migrates a fresh database and reruns without changing history", async () => {
		await applyMigrations(connectionString);
		const { db } = database();
		const schema = await db.execute(sql`SELECT to_regnamespace('app') AS name`);
		expect(schema.rows[0]).toEqual({ name: "app" });
		const [created] = await db
			.insert(user)
			.values({
				id: "migration-check",
				name: "Migration check",
				email: "migration-check@example.invalid",
			})
			.returning({ createdAt: user.createdAt, updatedAt: user.updatedAt });
		expect(created.createdAt).toBeInstanceOf(Date);
		expect(created.updatedAt).toBeInstanceOf(Date);
		const before = await db.execute(
			sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
		);
		await applyMigrations(connectionString);
		const after = await db.execute(
			sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
		);
		expect(after.rows).toEqual(before.rows);
		expect(before.rows.length).toBeGreaterThan(0);
	});

	test("serializes concurrent migration jobs on a fresh database", async () => {
		const folder = await withNextMigration(
			"SELECT pg_sleep(0.1);\n--> statement-breakpoint\nCREATE TABLE app.migration_probe (id integer);",
		);
		await Promise.all([
			applyMigrations(connectionString, folder),
			applyMigrations(connectionString, folder),
		]);
		const { db } = database();
		const result = await db.execute(
			sql`SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations`,
		);
		const original = JSON.parse(
			await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"),
		);
		expect(result.rows[0]).toEqual({ count: original.entries.length + 1 });
	});

	test("rolls back failed DDL and releases the migration lock", async () => {
		await applyMigrations(connectionString);
		const folder = await withNextMigration(
			"CREATE TABLE app.failed_probe (id integer);\n--> statement-breakpoint\nSELECT missing_function_for_test();",
		);
		await expect(applyMigrations(connectionString, folder)).rejects.toThrow();
		const { db } = database();
		expect(
			(await db.execute(sql`SELECT to_regclass('app.failed_probe') AS name`))
				.rows[0],
		).toEqual({ name: null });
		await applyMigrations(connectionString);
	});
});
