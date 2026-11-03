import { afterEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDatabase } from "../../src/db/client.server";

const originalUrl = process.env.DATABASE_URL;

afterEach(async () => {
	await closeDatabase();
	if (originalUrl === undefined) {
		delete process.env.DATABASE_URL;
	} else {
		process.env.DATABASE_URL = originalUrl;
	}
});

describe("application database lifecycle", () => {
	test("requires configuration only when the database is used", () => {
		delete process.env.DATABASE_URL;
		expect(() => getDatabase()).toThrow("DATABASE_URL is required");
	});

	test("reuses the lazy client and can close without opening a connection", async () => {
		process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:1/unused";
		const first = getDatabase();
		expect(getDatabase()).toBe(first);
		await closeDatabase();
		expect(getDatabase()).not.toBe(first);
	});
});
