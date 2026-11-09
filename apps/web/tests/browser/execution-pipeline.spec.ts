import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { actorService } from "../../src/auth/actor.server";
import * as credentialDomain from "../../src/credentials/credentials.server";
import type { TelemetryResult } from "../../src/executions/contracts";
import * as executionDomain from "../../src/executions/executions.server";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";

import { data, expect, test } from "./fixtures";

test("real Linux collector to Kafka/ClickHouse to authorized English/French execution page", async ({
	page,
	workspace,
}, testInfo) => {
	test.setTimeout(180000);
	function required(name: string) {
		const value = process.env[name];
		if (!value || value.trim() !== value || /[\r\n\0]/.test(value))
			throw new Error(`${name} must be explicitly configured`);
		return value;
	}
	function positive(name: string) {
		const value = required(name);
		if (
			!/^[1-9]\d*$/.test(value) ||
			BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
		)
			throw new Error(`${name} must be a positive safe integer`);
		return value;
	}
	const root = resolve(import.meta.dirname, "../../../..");
	const suffix = randomUUID().replaceAll("-", "");
	const relativeDirectory = `.state/pipeline/${suffix}`;
	const directory = resolve(root, relativeDirectory);
	const hostRoot = required("RECOUNT_PIPELINE_HOST_ROOT");
	const binaries = required("RECOUNT_PIPELINE_BIN_DIRECTORY");
	if (!isAbsolute(hostRoot) || !isAbsolute(binaries))
		throw new Error(
			"Pipeline host root and Linux binary directory must be absolute host paths",
		);
	const hostDirectory = resolve(hostRoot, relativeDirectory);
	const network = required("RECOUNT_PIPELINE_NETWORK");
	const databaseNetwork = required("RECOUNT_PIPELINE_DATABASE_NETWORK");
	const composeProject = required("RECOUNT_PIPELINE_COMPOSE_PROJECT");
	if (
		![network, databaseNetwork, composeProject].every((value) =>
			/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value),
		) ||
		[hostRoot, binaries].some((value) => value.includes(","))
	)
		throw new Error("Allocated Docker names and bind paths are invalid");
	if (process.env.RECOUNT_PIPELINE_ISOLATED !== "true")
		throw new Error("An explicitly allocated isolated pipeline is required");
	const images = new Map(
		["collector", "ingestion-api", "normalizer"].map((role) => [
			role,
			required(
				`RECOUNT_PIPELINE_${role.replaceAll("-", "_").toUpperCase()}_IMAGE`,
			),
		]),
	);
	const bootstrapAddress = required("RECOUNT_PIPELINE_BOOTSTRAP");
	const rawTopic = required("RECOUNT_PIPELINE_RAW_TOPIC");
	const normalizedTopic = required("RECOUNT_PIPELINE_NORMALIZED_TOPIC");
	const group = required("RECOUNT_PIPELINE_NORMALIZER_GROUP");
	const nativeGroup = required("RECOUNT_PIPELINE_NATIVE_GROUP");
	const brokerId = required("RECOUNT_PIPELINE_KAFKA_CONTAINER_ID");
	if (
		rawTopic === normalizedTopic ||
		[rawTopic, normalizedTopic].some(
			(topic) =>
				!/^[A-Za-z0-9_.-]{1,249}$/.test(topic) ||
				[
					".",
					"..",
					"recount.metrics.raw",
					"recount.metrics.normalized",
				].includes(topic),
		) ||
		group === "recount-normalizer" ||
		!/^[A-Za-z0-9_.-]{1,249}$/.test(group) ||
		!/^[A-Za-z0-9_.-]{1,249}$/.test(nativeGroup) ||
		!/^[a-f0-9]{64}$/.test(brokerId) ||
		!bootstrapAddress
			.split(",")
			.every((address) => /^[A-Za-z0-9_.-]+:\d+$/.test(address))
	)
		throw new Error(
			"Fresh allocated topics, group and broker addresses are required; main pipeline defaults are forbidden",
		);
	const limits = Object.fromEntries(
		[
			"RECOUNT_MAX_REQUEST_BYTES",
			"RECOUNT_MAX_POINTS",
			"RECOUNT_MAX_EXPANDED_ITEMS",
			"RECOUNT_MAX_AUTHORITIES",
			"RECOUNT_MAX_ATTRIBUTE_NODES",
			"RECOUNT_NORMALIZED_MAX_RECORD_BYTES",
			"RECOUNT_NORMALIZED_MAX_OUTPUT_BYTES",
			"RECOUNT_RAW_BROKER_MAX_BYTES",
			"RECOUNT_NORMALIZED_BROKER_MAX_BYTES",
		].map((name) => [name, positive(name)]),
	);
	const kafka = {
		...limits,
		RECOUNT_KAFKA_BOOTSTRAP: bootstrapAddress,
		RECOUNT_RAW_TOPIC: rawTopic,
		RECOUNT_NORMALIZED_TOPIC: normalizedTopic,
		RECOUNT_RAW_PARTITIONS: positive("RECOUNT_PIPELINE_RAW_PARTITIONS"),
		RECOUNT_NORMALIZED_PARTITIONS: positive(
			"RECOUNT_PIPELINE_NORMALIZED_PARTITIONS",
		),
		RECOUNT_NORMALIZER_GROUP: group,
	};
	const collectorBounds = [
		"--interval-ms",
		"500",
		"--queue-max-bytes",
		"8388608",
		"--queue-max-batches",
		"32",
		"--queue-max-age-seconds",
		"60",
	];
	const restartClickHouse =
		process.env.RECOUNT_PIPELINE_RESTART_CLICKHOUSE === "true";
	if (!restartClickHouse)
		throw new Error(
			"The full pipeline gate requires an explicit ClickHouse restart allocation",
		);
	const clickhouseContainer = restartClickHouse
		? required("RECOUNT_PIPELINE_CLICKHOUSE_CONTAINER")
		: null;
	const clickhouseId = restartClickHouse
		? required("RECOUNT_PIPELINE_CLICKHOUSE_CONTAINER_ID")
		: null;
	if (clickhouseId && !/^[a-f0-9]{64}$/.test(clickhouseId))
		throw new Error(
			"ClickHouse restart requires its allocated full immutable container ID",
		);
	if (
		clickhouseContainer &&
		!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(clickhouseContainer)
	)
		throw new Error("ClickHouse restart requires its allocated container name");
	const secrets = new Set<string>();
	function rememberSecret(value: string) {
		if (/[\r\n]/.test(value))
			throw new Error("Pipeline fixture secrets must be single-line");
		if (value) secrets.add(value);
	}
	for (const [key, value] of Object.entries(process.env))
		if (value && /PASSWORD|TOKEN|SECRET|DATABASE_URL/.test(key))
			rememberSecret(value);
	function sanitize(value: string) {
		for (const secret of secrets)
			value = value.replaceAll(secret, "[redacted]");
		return value
			.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted-database-url]")
			.replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
			.replace(
				/\b(password|token|secret)\s*[:=]\s*["']?[^,\s"'}]+/gi,
				"$1=[redacted]",
			)
			.replace(/\brecount_[A-Za-z0-9_-]+/g, "[redacted-token]");
	}
	const authorityPassword = randomUUID();
	rememberSecret(authorityPassword);
	const imageIds = new Map<string, string>();
	let restartStatus = restartClickHouse
		? "NOT_RUN_NOT_REACHED"
		: "NOT_RUN_DISABLED";
	let roleCreated = false;
	const names: string[] = [];
	const role = `recount_pipeline_reader_${suffix}`;
	const children: ReturnType<typeof spawn>[] = [];
	const processNames = new Map<ReturnType<typeof spawn>, string>();
	const componentOutput = new Map<string, string>();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(sanitize(error.message)));
	page.on("console", (message) => {
		if (/hydration|did not match/i.test(message.text()))
			errors.push(sanitize(message.text()));
	});
	function start(
		component: string,
		args: string[],
		mounts: string[] = [],
		instance = component,
		environment: Record<string, string> = {},
	) {
		const name = `recount-pipeline-${instance}-${suffix}`;
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
				...(component === "ingestion-api" &&
				databaseNetwork &&
				databaseNetwork !== network
					? ["--network", databaseNetwork]
					: []),
				"--cpus=0.5",
				"--memory=384m",
				"--memory-swap=384m",
				"--read-only",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges",
				"--pids-limit=128",
				"--user",
				`${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
				...mounts,
				// Name-only flags keep the authority URL out of process arguments.
				...Object.keys(environment).flatMap((key) => ["--env", key]),
				imageIds.get(component) ?? "missing-packaged-image",
				...args,
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...environment },
			},
		);
		function retainSanitizedLine(line: string) {
			const sanitized = sanitize(line);
			componentOutput.set(
				name,
				`${componentOutput.get(name) ?? ""}${sanitized}\n`.slice(-12000),
			);
		}
		function lineCapture() {
			const decoder = new StringDecoder("utf8");
			let pending = "";
			let dropping = false;
			function consume(text: string) {
				for (const character of text) {
					if (character === "\n") {
						if (!dropping) retainSanitizedLine(pending);
						pending = "";
						dropping = false;
					} else if (!dropping) {
						// Drop the whole oversized line, never retain a raw suffix.
						if (pending.length + character.length > 4096) {
							pending = "";
							dropping = true;
						} else pending += character;
					}
				}
			}
			return {
				write(chunk: Buffer) {
					consume(decoder.write(chunk));
				},
				close() {
					consume(decoder.end());
					if (pending && !dropping) retainSanitizedLine(pending);
					pending = "";
					dropping = false;
				},
			};
		}
		const stdoutCapture = lineCapture();
		const stderrCapture = lineCapture();
		child.stdout?.on("data", stdoutCapture.write);
		child.stderr?.on("data", stderrCapture.write);
		child.once("close", () => {
			stdoutCapture.close();
			stderrCapture.close();
		});
		children.push(child);
		processNames.set(child, name);
		return name;
	}
	try {
		const brokerIdentity = spawnSync(
			"docker",
			[
				"inspect",
				"--type",
				"container",
				"--format",
				'{{.Id}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}',
				brokerId,
			],
			{ encoding: "utf8", timeout: 10000 },
		);
		expect(brokerIdentity.status).toBe(0);
		expect(brokerIdentity.stdout.trim()).toBe(
			`${brokerId}|${composeProject}|kafka|true`,
		);
		function kafkaRead(tool: string, ...args: string[]) {
			const result = spawnSync(
				"docker",
				[
					"exec",
					"--env",
					"KAFKA_HEAP_OPTS=-Xms16m -Xmx96m",
					brokerId,
					`/opt/kafka/bin/${tool}.sh`,
					"--bootstrap-server",
					bootstrapAddress,
					...args,
				],
				{ encoding: "utf8", timeout: 10000 },
			);
			expect(result.status, `Read allocated Kafka ${tool}`).toBe(0);
			return result.stdout;
		}
		async function drain(topic: string, consumer: string, partitions: string) {
			const end = kafkaRead(
				"kafka-get-offsets",
				"--topic",
				topic,
				"--time",
				"latest",
			)
				.trim()
				.split("\n")
				.map((line) => line.trim().split(":"))
				.map(([name, partition, offset]) => {
					expect(name).toBe(topic);
					expect(partition).toMatch(/^\d+$/);
					expect(offset).toMatch(/^\d+$/);
					return `${partition}:${offset}`;
				})
				.sort();
			expect(end).toHaveLength(Number(partitions));
			await expect
				.poll(
					() =>
						kafkaRead(
							"kafka-consumer-groups",
							"--group",
							consumer,
							"--describe",
						)
							.split("\n")
							.map((line) => line.trim().split(/\s+/))
							.filter(([name, source]) => name === consumer && source === topic)
							.map((fields) => `${fields[2]}:${fields[3]}`)
							.sort(),
					{ timeout: 30000, intervals: [1000] },
				)
				.toEqual(end);
			return end;
		}
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const binaryIdentity = [];
		for (const binary of [
			"recount-collector",
			"recount-ingestion-api",
			"recount-normalizer",
		]) {
			const digest = createHash("sha256");
			let bytes = 0;
			for await (const chunk of createReadStream(resolve(binaries, binary))) {
				if (
					bytes === 0 &&
					!chunk.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
				)
					throw new Error(
						"Pipeline artifacts must be precompiled Linux ELF binaries",
					);
				digest.update(chunk);
				bytes += chunk.length;
			}
			if (!bytes) throw new Error("Empty pipeline binary artifact");
			binaryIdentity.push({ binary, bytes, sha256: digest.digest("hex") });
		}
		for (const [role, image] of images) {
			const inspected = spawnSync(
				"docker",
				["image", "inspect", "--format", "{{.Id}}", image],
				{ encoding: "utf8", timeout: 10000 },
			);
			const id = inspected.stdout?.trim() ?? "";
			if (inspected.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(id))
				throw new Error(`Packaged ${role} image is unavailable`);
			const digest = spawnSync(
				"docker",
				[
					"run",
					"--rm",
					"--network",
					"none",
					"--read-only",
					"--memory",
					"64m",
					"--pids-limit",
					"32",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--entrypoint",
					"sha256sum",
					id,
					`/usr/local/bin/recount-${role}`,
				],
				{ encoding: "utf8", timeout: 10000 },
			);
			expect(digest.status, `Inspect packaged ${role} executable`).toBe(0);
			expect(digest.stdout.split(/\s+/)[0]).toBe(
				binaryIdentity.find((entry) => entry.binary === `recount-${role}`)
					?.sha256,
			);
			imageIds.set(role, id);
		}
		await testInfo.attach("pipeline-artifact-identity", {
			body: JSON.stringify({
				binaryIdentity,
				images: Object.fromEntries(imageIds),
				runnerRoot: root,
				hostRoot,
				binaries,
				composeProject,
				network,
				databaseNetwork,
				bootstrapAddress,
				rawTopic,
				normalizedTopic,
				group,
				limits,
				rawPartitions: kafka.RECOUNT_RAW_PARTITIONS,
				normalizedPartitions: kafka.RECOUNT_NORMALIZED_PARTITIONS,
				nativeInsertPartitionCeiling: positive(
					"RECOUNT_NORMALIZER_OUTPUT_ROWS",
				),
				collectorBounds,
				containerMemoryMiB: 384,
				containerSwapMiB: 0,
				restartRequested: restartClickHouse,
			}),
			contentType: "application/json",
		});
		await Promise.all(
			["queue", "other-queue"].map((name) =>
				mkdir(resolve(directory, name), { mode: 0o700 }),
			),
		);
		const owner = await workspace.signIn(
			page,
			"pipeline-owner@example.invalid",
		);
		const organization = data(
			await workspace.operations(owner.headers, () =>
				organizationDomain.createOrganization(workspace.auth, owner.headers, {
					name: "Pipeline",
					slug: `pipeline-${suffix}`,
				}),
			),
		);
		const project = data(
			await workspace.operations(owner.headers, (actor) =>
				projectDomain.createProject(workspace.database.db, actor, {
					requestId: crypto.randomUUID(),
					organizationId: organization.id,
					name: "Real measurements",
					slug: "real",
				}),
			),
		);
		const reference = {
			organizationId: organization.id,
			projectId: project.id,
		};
		const credentials = actorService(workspace.auth);
		const enrolled = data(
			await credentials(owner.headers, (actor) =>
				credentialDomain.createCollectorCredential(
					workspace.database.db,
					actor,
					{
						...reference,
						name: "Linux collector",
						sourceId: `source-${suffix}`,
						rootId: "pipeline-node",
						rootKind: 1,
						adapter: "linux",
						allowedLocalKinds: [4],
						additionalRoots: [
							{
								resourceId: "other-node",
								resourceKind: 1,
								adapter: "linux",
								allowedLocalKinds: [4],
							},
						],
					},
				),
			),
		);
		rememberSecret(enrolled.token);
		await writeFile(resolve(directory, "token"), enrolled.token, {
			mode: 0o600,
		});
		const databaseUrl = new URL(workspace.databaseUrl);
		await workspace.database.pool.query(
			`CREATE ROLE ${role} LOGIN PASSWORD '${authorityPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
		);
		roleCreated = true;
		await workspace.database.pool.query(
			`GRANT CONNECT ON DATABASE "${databaseUrl.pathname.slice(1)}" TO ${role}; GRANT USAGE ON SCHEMA ingestion TO ${role}; GRANT SELECT ON ingestion.collector_credential,ingestion.collector_root_grant,ingestion.collector_resource_grant TO ${role}`,
		);
		databaseUrl.hostname =
			process.env.RECOUNT_PIPELINE_DATABASE_HOST ?? "credential-postgres";
		databaseUrl.port = process.env.RECOUNT_PIPELINE_DATABASE_PORT ?? "5432";
		databaseUrl.username = role;
		databaseUrl.password = authorityPassword;
		databaseUrl.searchParams.set("sslmode", "disable");
		rememberSecret(databaseUrl.password);
		rememberSecret(databaseUrl.toString());
		const startedAt = new Date(Date.now() - 1000);
		start("normalizer", ["bootstrap"], [], "normalizer-bootstrap", kafka);
		const bootstrap = children.pop();
		if (!bootstrap) throw new Error("Missing normalizer bootstrap process");
		const bootstrapExit = await once(bootstrap, "exit", {
			signal: AbortSignal.timeout(30000),
		});
		expect(bootstrapExit[0], "Explicit fresh-group bootstrap succeeds").toBe(0);
		const normalizer = start("normalizer", [], [], "normalizer", kafka);
		const ingestion = start("ingestion-api", [], [], "ingestion-api", {
			...kafka,
			RECOUNT_INGESTION_ADDR: "0.0.0.0:4317",
			RECOUNT_INGESTION_DATABASE_URL: databaseUrl.toString(),
		});
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
				...collectorBounds,
			],
			[
				"--mount",
				`type=bind,src=${hostDirectory}/token,dst=/test/token,readonly`,
				"--mount",
				`type=bind,src=${hostDirectory}/queue,dst=/test/queue`,
			],
		);
		const otherCollector = start(
			"collector",
			[
				"--endpoint",
				`http://${ingestion}:4317`,
				"--source-token-file",
				"/test/token",
				"--host-id",
				"other-node",
				"--process-namespace-id",
				"other-container",
				"--queue-directory",
				"/test/other-queue",
				...collectorBounds,
			],
			[
				"--mount",
				`type=bind,src=${hostDirectory}/token,dst=/test/token,readonly`,
				"--mount",
				`type=bind,src=${hostDirectory}/other-queue,dst=/test/other-queue`,
			],
			"collector-other",
		);
		const executions = actorService(workspace.auth);
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
			await executions(owner.headers, (actor) =>
				executionDomain.listExecutions(workspace.database.db, actor, reference),
			),
		);
		expect(listed.executions).toHaveLength(1);
		const entry = listed.executions[0];
		const ref = { ...reference, executionId: entry.executionId };
		const otherEntry = data(
			await executions(owner.headers, (actor) =>
				executionDomain.createExecution(workspace.database.db, actor, {
					requestId: crypto.randomUUID(),
					...reference,
					name: "Other host capture",
					credentialId: enrolled.credential.id,
					hostId: "other-node",
					startedAt: startedAt.toISOString(),
					endedAt: new Date(startedAt.getTime() + 300000).toISOString(),
				}),
			),
		);
		await expect
			.poll(
				async () => {
					for (const child of children) {
						if (child.exitCode !== null || child.signalCode !== null)
							throw new Error(
								`Pipeline component ${processNames.get(child)} exited: ${sanitize(componentOutput.get(processNames.get(child) ?? "") ?? "")}`,
							);
					}
					const response = await executions(owner.headers, (actor) =>
						executionDomain.queryExecutionTelemetry(
							workspace.database.db,
							actor,
							ref,
						),
					);
					const other = await executions(owner.headers, (actor) =>
						executionDomain.queryExecutionTelemetry(
							workspace.database.db,
							actor,
							otherEntry,
						),
					);
					if (!response.data || !other.data) return false;
					for (const [data, host] of [
						[response.data, "pipeline-node"],
						[other.data, "other-node"],
					] as const) {
						if (
							!data.series.length ||
							data.series.some((s) => s.hostId !== host)
						)
							return false;
						for (const metric of [
							"recount.node.cpu.time",
							"recount.node.memory.total",
						]) {
							const timestamps = new Set(
								data.series
									.filter((s) => s.metric === metric)
									.flatMap((s) =>
										s.segments.flatMap((segment) =>
											segment.points.map((p) => p.timeNs),
										),
									),
							);
							if (timestamps.size < 3) return false;
						}
					}
					return true;
				},
				{ timeout: 60000, intervals: [1000] },
			)
			.toBe(true);
		for (const name of [otherCollector, collector, ingestion]) {
			const stopped = spawnSync("docker", ["stop", "--timeout", "5", name], {
				encoding: "utf8",
				timeout: 15000,
			});
			expect(stopped.status, `Stop publisher ${name}`).toBe(0);
		}
		// Confirm both durable prefixes before taking an exact restart baseline.
		const rawEnd = await drain(rawTopic, group, kafka.RECOUNT_RAW_PARTITIONS);
		const stopped = spawnSync(
			"docker",
			["stop", "--timeout", "5", normalizer],
			{
				encoding: "utf8",
				timeout: 15000,
			},
		);
		expect(stopped.status).toBe(0);
		const normalizedEnd = await drain(
			normalizedTopic,
			nativeGroup,
			kafka.RECOUNT_NORMALIZED_PARTITIONS,
		);
		await testInfo.attach("pipeline-drained-prefixes", {
			body: JSON.stringify({ rawEnd, normalizedEnd, group, nativeGroup }),
			contentType: "application/json",
		});
		let captured: TelemetryResult[] = [];
		await expect
			.poll(
				async () => {
					const results = await Promise.all([
						executions(owner.headers, (actor) =>
							executionDomain.queryExecutionTelemetry(
								workspace.database.db,
								actor,
								ref,
							),
						),
						executions(owner.headers, (actor) =>
							executionDomain.queryExecutionTelemetry(
								workspace.database.db,
								actor,
								otherEntry,
							),
						),
					]);
					if (!results.every((result) => result.data)) return false;
					captured = results.map((result) => data(result));
					return true;
				},
				{ timeout: 30000 },
			)
			.toBe(true);
		// Use the shared published interval after every acknowledged record is visible.
		const frozenEnd = new Date(
			Math.min(
				...captured.map((result) =>
					Number(
						result.series
							.flatMap((series) => series.segments)
							.flatMap((segment) => segment.points)
							.reduce(
								(latest, point) =>
									BigInt(point.timeNs) > latest ? BigInt(point.timeNs) : latest,
								0n,
							) / 1_000_000n,
					),
				),
			),
		).toISOString();
		const snapshot = async () => {
			const results = await Promise.all([
				executions(owner.headers, (actor) =>
					executionDomain.queryExecutionTelemetry(
						workspace.database.db,
						actor,
						{
							...ref,
							to: frozenEnd,
						},
					),
				),
				executions(owner.headers, (actor) =>
					executionDomain.queryExecutionTelemetry(
						workspace.database.db,
						actor,
						{
							...otherEntry,
							to: frozenEnd,
						},
					),
				),
			]);
			return results.every((result) => result.data?.series.length)
				? JSON.stringify(results.map((result) => result.data))
				: undefined;
		};
		let beforeRestart: string | undefined;
		await expect
			.poll(async () => (beforeRestart = await snapshot()), { timeout: 30000 })
			.toBeTruthy();
		if (restartClickHouse && clickhouseContainer && clickhouseId) {
			const inspected = spawnSync(
				"docker",
				[
					"inspect",
					"--type",
					"container",
					"--format",
					`{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"network":{{json (index .NetworkSettings.Networks "${network}")}}}`,
					clickhouseContainer,
				],
				{ encoding: "utf8", timeout: 10000 },
			);
			if (inspected.status !== 0)
				throw new Error("Allocated ClickHouse identity inspection failed");
			const identity = JSON.parse(inspected.stdout) as {
				id: string;
				name: string;
				image: string;
				project: string;
				service: string;
				running: boolean;
				network: unknown;
			};
			if (
				identity.id !== clickhouseId ||
				identity.name !== `/${clickhouseContainer}` ||
				identity.project !== composeProject ||
				identity.service !== "clickhouse" ||
				identity.running !== true ||
				!identity.network
			)
				throw new Error(
					"Refusing to restart a ClickHouse container outside the approved allocation",
				);
			restartStatus = "FAILED";
			const restart = spawnSync(
				"docker",
				["restart", "--time", "10", identity.id],
				{ encoding: "utf8", timeout: 45000 },
			);
			expect(
				restart.status,
				"Allocated immutable ClickHouse container restart succeeds",
			).toBe(0);
			await expect
				.poll(snapshot, { timeout: 30000, intervals: [1000] })
				.toBe(beforeRestart);
			restartStatus = "PASSED";
			await testInfo.attach("pipeline-restart-identity", {
				body: JSON.stringify({
					id: identity.id,
					name: identity.name,
					image: identity.image,
					project: identity.project,
					service: identity.service,
					network,
				}),
				contentType: "application/json",
			});
		}
		const href = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}/executions/${entry.executionId}`;
		for (const locale of ["en", "fr"] as const) {
			await page
				.context()
				.addCookies([
					{ name: "recount_locale", value: locale, url: workspace.origin },
				]);
			const response = await page.goto(href);
			expect(response?.status()).toBe(200);
			await expect(
				page.getByRole("heading", { name: "Collector capture" }),
			).toBeVisible();
			await expect(
				page.locator("[data-continuity-segment] circle").first(),
			).toBeVisible();
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
			expect(html).toMatch(new RegExp(`<html\\b[^>]*\\blang="${locale}"`));
			expect(html?.includes(enrolled.token)).toBe(false);
			const readerPassword = process.env.RECOUNT_CLICKHOUSE_READER_PASSWORD;
			if (readerPassword) expect(html?.includes(readerPassword)).toBe(false);
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
			(
				await executions(new Headers(), (actor) =>
					executionDomain.queryExecutionTelemetry(
						workspace.database.db,
						actor,
						ref,
					),
				)
			).error?.code,
		).toBe("UNAUTHENTICATED");
		expect(errors).toEqual([]);
	} finally {
		try {
			await testInfo.attach("pipeline-restart-status", {
				body: JSON.stringify({
					requested: restartClickHouse,
					status: restartStatus,
				}),
				contentType: "application/json",
			});
			await testInfo.attach("pipeline-output", {
				body: [...componentOutput.entries()]
					.map(([name, output]) => `${name}\n${sanitize(output)}`)
					.join("\n"),
				contentType: "text/plain",
			});
		} finally {
			for (const name of names.reverse())
				spawnSync("docker", ["stop", "--time", "3", name], {
					stdio: "ignore",
					timeout: 15000,
				});
			for (const child of children) child.unref();
			if (roleCreated)
				await workspace.database.pool
					.query(
						`REASSIGN OWNED BY ${role} TO CURRENT_USER; DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role}`,
					)
					.catch(() => {});
			await rm(directory, { recursive: true, force: true });
		}
	}
});
