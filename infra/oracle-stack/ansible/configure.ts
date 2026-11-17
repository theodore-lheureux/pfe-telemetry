import { generateKeyPairSync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

export function runtimeConfiguration(
	mount: string,
	release: string,
	smtp: Record<string, string>,
) {
	for (const key of [
		"SMTP_HOST",
		"SMTP_PORT",
		"SMTP_USER",
		"SMTP_PASSWORD",
		"EMAIL_FROM",
	]) {
		if (!smtp[key] || /[\r\n\0]/.test(smtp[key]))
			throw new Error(`Missing or invalid ${key}`);
	}
	const secret = () => randomBytes(32).toString("hex");
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const postgres = secret();
	const web = secret();
	const ingestion = secret();
	const values: Record<string, string> = {
		POSTGRES_PASSWORD: postgres,
		DATABASE_URL: `postgresql://recount_web:${web}@postgres:5432/recount`,
		RECOUNT_INGESTION_DATABASE_URL: `postgresql://recount_ingestion:${ingestion}@postgres:5432/recount?sslmode=disable`,
		CLICKHOUSE_ADMIN_PASSWORD: secret(),
		CLICKHOUSE_READER_PASSWORD: secret(),
		BETTER_AUTH_SECRET: secret(),
		BETTER_AUTH_URL: "https://app.recount.cloud",
		RECOUNT_AUTH_ALLOW_SIGN_UP: "false",
		RECOUNT_LIVE_GATEWAY_SECRET: secret(),
		RECOUNT_COLLECTOR_SIGNING_KEY: privateKey.export({ format: "jwk" }).d ?? "",
		RECOUNT_INGESTION_COLLECTOR_PUBLIC_KEYS:
			publicKey.export({ format: "jwk" }).x ?? "",
		RECOUNT_SCHEMA_DIRECTORY: "/opt/recount/backend/schema",
		RECOUNT_CLICKHOUSE_IMAGE: `recount-clickhouse:${release}`,
		RECOUNT_POSTGRES_DATA_DIRECTORY: `${mount}/postgres`,
		RECOUNT_KAFKA_DATA_DIRECTORY: `${mount}/kafka`,
		RECOUNT_CLICKHOUSE_DATA_DIRECTORY: `${mount}/clickhouse`,
	};
	for (const key of [
		"SMTP_HOST",
		"SMTP_PORT",
		"SMTP_USER",
		"SMTP_PASSWORD",
		"EMAIL_FROM",
	])
		values[key] = smtp[key];
	return Object.entries(values)
		.map(
			([key, value]) =>
				`${key}=${JSON.stringify(value).replaceAll("$", () => "$$")}`,
		)
		.join("\n")
		.concat("\n");
}

if (import.meta.main) {
	const [mount, release] = process.argv.slice(2);
	if (
		!mount?.startsWith("/") ||
		!/^[a-f0-9]{40}-[0-9]+-[0-9]+$/.test(release ?? "")
	)
		throw new Error("Expected an absolute data mount and approved release ID");
	const smtp = JSON.parse(await Bun.stdin.text());
	writeFileSync(
		"/etc/recount/ingestion.env",
		runtimeConfiguration(mount, release, smtp),
		{ mode: 0o600, flag: "wx" },
	);
}
