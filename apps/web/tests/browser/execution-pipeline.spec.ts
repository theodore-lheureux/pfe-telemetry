import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createCollectorCredentialRequests } from "../../src/credentials/credentials.server";
import { createExecutionRequests } from "../../src/executions/request.server";
import { data, expect, test } from "./fixtures";

test.skip(
	process.env.PFE_PIPELINE_TEST !== "true",
	"Requires isolated Linux binaries, Kafka and ClickHouse test stack",
);

test("real Linux collector to Kafka/ClickHouse to authorized English/French execution page", async ({
	page,
	workspace,
}, testInfo) => {
	test.setTimeout(120000);
	const root = resolve(import.meta.dirname, "../../../..");
	const suffix = randomUUID().replaceAll("-", "");
	const directory = resolve(root, ".state/clickhouse-handoff/e2e", suffix);
	const network =
		process.env.PFE_PIPELINE_NETWORK ?? "pfe20-clickhouse_default";
	const image =
		process.env.PFE_PIPELINE_RUST_IMAGE ??
		"pfe-telemetry-rust-integration:local";
	const target =
		process.env.PFE_PIPELINE_TARGET_VOLUME ?? "pfe20-clickhouse-cargo-target";
	const names: string[] = [];
	const role = `pfe20_reader_${suffix}`;
	const children: ReturnType<typeof spawn>[] = [];
	const componentOutput = new Map<string, string>();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (/hydration|did not match/i.test(message.text()))
			errors.push(message.text());
	});
	function start(component: string, args: string[], mounts: string[] = []) {
		const name = `pfe20-e2e-${component}-${suffix}`;
		names.push(name);
		const child = spawn(
			"docker",
			[
				"run",
				"--rm",
				"--name",
				name,
				"--network",
				network,
				...(component === "server"
					? [
							"--network",
							process.env.PFE_PIPELINE_DATABASE_NETWORK ??
								"pfe50-database-tests_default",
						]
					: []),
				"--cpus=0.5",
				"--memory=256m",
				"-v",
				`${target}:/pfe20-target:ro`,
				...mounts,
				image,
				`/pfe20-target/debug/pfe-${component}`,
				...args,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const capture = (chunk: Buffer) =>
			componentOutput.set(
				name,
				((componentOutput.get(name) ?? "") + chunk.toString()).slice(-4000),
			);
		child.stdout?.on("data", capture);
		child.stderr?.on("data", capture);
		children.push(child);
		return name;
	}
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const owner = await workspace.signIn(
			page,
			"pipeline-owner@example.invalid",
		);
		const organization = data(
			await workspace.operations.createOrganization(owner.headers, {
				name: "Pipeline",
				slug: `pipeline-${suffix}`,
			}),
		);
		const project = data(
			await workspace.operations.createProject(owner.headers, {
				organizationId: organization.id,
				name: "Real measurements",
				slug: "real",
			}),
		);
		const reference = {
			organizationId: organization.id,
			projectId: project.id,
		};
		const credentials = createCollectorCredentialRequests(
			workspace.database.db,
			workspace.auth,
		);
		const enrolled = data(
			await credentials.createCollectorCredential(owner.headers, {
				...reference,
				name: "Linux collector",
				sourceId: `source-${suffix}`,
				hosts: ["pipeline-node"],
			}),
		);
		await writeFile(resolve(directory, "token"), enrolled.token, {
			mode: 0o600,
		});
		const databaseUrl = new URL(workspace.databaseUrl);
		await workspace.database.pool.query(
			`CREATE ROLE ${role} LOGIN PASSWORD 'e2e-test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
		);
		await workspace.database.pool.query(
			`GRANT CONNECT ON DATABASE "${databaseUrl.pathname.slice(1)}" TO ${role}; GRANT USAGE ON SCHEMA ingestion TO ${role}; GRANT SELECT ON ingestion.collector_credential TO ${role}`,
		);
		databaseUrl.hostname = process.env.PFE_PIPELINE_DATABASE_HOST ?? "postgres";
		databaseUrl.port = process.env.PFE_PIPELINE_DATABASE_PORT ?? "5432";
		databaseUrl.username = role;
		databaseUrl.password = "e2e-test-only";
		databaseUrl.searchParams.set("sslmode", "disable");
		const startedAt = new Date(Date.now() - 1000);
		const ingestion = start("server", [
			"--address",
			"0.0.0.0:4317",
			"--database-url",
			databaseUrl.toString(),
			"--kafka-bootstrap",
			"kafka:9092",
		]);
		start("storage", [
			"--kafka-bootstrap",
			"kafka:9092",
			"--kafka-group",
			`pfe20-${suffix}`,
			"--clickhouse-url",
			"http://clickhouse:8123",
			"--clickhouse-password",
			process.env.TELEMETRY_CLICKHOUSE_PASSWORD as string,
		]);
		const collector = start(
			"collector",
			[
				"--endpoint",
				`http://${ingestion}:4317`,
				"--source-token-file",
				"/test/token",
				"--host-id",
				"pipeline-node",
				"--process-namespace-id",
				"container",
				"--queue-directory",
				"/test/queue",
				"--interval-ms",
				"500",
			],
			["-v", `${directory}:/test`],
		);
		const executions = createExecutionRequests(
			workspace.database.db,
			workspace.auth,
		);
		await page.goto(
			`${workspace.origin}/organizations/${organization.id}/projects/${project.id}/executions`,
		);
		await page
			.getByLabel("Execution name", { exact: true })
			.fill("Collector capture");
		await page
			.getByLabel("Host ID (optional, exact match)")
			.fill("pipeline-node");
		await page
			.getByLabel("Start (UTC ISO timestamp)")
			.fill(startedAt.toISOString());
		await page
			.getByLabel("End (UTC ISO timestamp, exclusive)")
			.fill(new Date(startedAt.getTime() + 300000).toISOString());
		await page
			.getByRole("button", { name: "Record execution", exact: true })
			.click();
		await expect(
			page.getByRole("link", { name: "Open saved execution" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Record execution", exact: true }),
		).toBeDisabled();
		const listed = data(
			await executions.listExecutions(owner.headers, reference),
		);
		expect(listed.executions).toHaveLength(1);
		const entry = listed.executions[0];
		const ref = { ...reference, executionId: entry.executionId };
		await expect
			.poll(
				async () => {
					for (const [index, child] of children.entries()) {
						if (child.exitCode !== null || child.signalCode !== null)
							throw new Error(
								`Pipeline component ${names[index]} exited: ${componentOutput.get(names[index]) ?? ""}`,
							);
					}
					const response = await executions.queryExecutionTelemetry(
						owner.headers,
						ref,
					);
					return (
						response.data?.series.reduce(
							(count, series) => count + series.points.length,
							0,
						) ?? 0
					);
				},
				{ timeout: 60000, intervals: [1000] },
			)
			.toBeGreaterThan(3);
		spawnSync("docker", ["stop", "--time", "5", collector], {
			stdio: "ignore",
			timeout: 15000,
		});
		const href = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}/executions/${entry.executionId}`;
		for (const locale of ["en", "fr"] as const) {
			await page
				.context()
				.addCookies([
					{ name: "pfe_locale", value: locale, url: workspace.origin },
				]);
			const response = await page.goto(href);
			expect(response?.status()).toBe(200);
			await expect(
				page.getByRole("heading", { name: "Collector capture" }),
			).toBeVisible();
			await expect(page.locator("svg circle").first()).toBeVisible();
			await expect(
				page
					.getByRole("columnheader", {
						name:
							locale === "en"
								? "Sample timestamp (Unix nanoseconds)"
								: "Horodatage de la mesure (nanosecondes Unix)",
					})
					.first(),
			).toBeVisible();
			const html = await response?.text();
			expect(html).toContain(`<html lang="${locale}">`);
			expect(html).not.toContain(enrolled.token);
			expect(html).not.toContain(process.env.TELEMETRY_CLICKHOUSE_PASSWORD);
			await page.screenshot({
				path: testInfo.outputPath(`execution-${locale}.png`),
				fullPage: true,
			});
		}
		await workspace.signIn(page, "pipeline-outsider@example.invalid");
		const denied = await page.goto(href);
		expect(denied?.status()).toBe(404);
		expect(await page.content()).not.toContain("Collector capture");
		expect(
			(await executions.queryExecutionTelemetry(new Headers(), ref)).error
				?.code,
		).toBe("UNAUTHENTICATED");
		expect(errors).toEqual([]);
	} finally {
		await testInfo.attach("pipeline-output", {
			body: [...componentOutput.entries()]
				.map(([name, output]) => `${name}\n${output}`)
				.join("\n"),
			contentType: "text/plain",
		});
		for (const name of names.reverse())
			spawnSync("docker", ["stop", "--time", "3", name], {
				stdio: "ignore",
				timeout: 15000,
			});
		for (const child of children) child.unref();
		await workspace.database.pool
			.query(
				`REASSIGN OWNED BY ${role} TO CURRENT_USER; DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role}`,
			)
			.catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
});
