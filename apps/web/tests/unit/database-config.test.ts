import { describe, expect, test } from "bun:test";
import { readDatabaseConfig } from "../../src/db/config.server";

describe("database configuration", () => {
	const connectionString = "postgresql://pfe:secret@localhost:15432/pfe";

	test("accepts a pool limit and rejects out-of-range limits", () => {
		expect(
			readDatabaseConfig({
				DATABASE_URL: connectionString,
				DATABASE_POOL_MAX: "3",
			}).max,
		).toBe(3);
		for (const value of ["0", "101"]) {
			expect(() =>
				readDatabaseConfig({
					DATABASE_URL: connectionString,
					DATABASE_POOL_MAX: value,
				}),
			).toThrow("DATABASE_POOL_MAX");
		}
	});

	test("rejects malformed URLs without exposing credentials", () => {
		expect(() =>
			readDatabaseConfig({ DATABASE_URL: "postgresql://user:secret@" }),
		).toThrow(/^DATABASE_URL must be a PostgreSQL connection URL$/);
	});
});
