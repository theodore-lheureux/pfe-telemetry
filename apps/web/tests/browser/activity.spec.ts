import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { ClickHouseLogLevel, createClient } from "@clickhouse/client";
import { m } from "@recount/i18n/messages";
import { Kafka, logLevel } from "kafkajs";
import protobuf from "protobufjs/light.js";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { data, expect, test } from "./fixtures";

const allowed = process.env.RECOUNT_ACTIVITY_TEST_ALLOW_PUBLISH === "1";
test.skip(
	!allowed,
	"Requires explicit reused Kafka/ClickHouse endpoints and disposable project permission",
);

test("Activity has compact real point rows, expandable JSON, live packets, pause, disabled filters and French labels", async ({
	page,
	workspace,
}, testInfo) => {
	const topic = process.env.RECOUNT_RAW_TOPIC ?? "";
	const liveTopic = process.env.RECOUNT_LIVE_TOPIC ?? "";
	if (
		!liveTopic.startsWith("recount.test.activity.") ||
		!process.env.RECOUNT_LIVE_GATEWAY_URL ||
		!process.env.RECOUNT_LIVE_GATEWAY_SECRET
	)
		throw new Error("Explicit disposable Live configuration required");
	if (!topic.startsWith("recount.test.activity."))
		throw new Error("Explicit disposable Activity topic required");
	const actor = await workspace.signIn(
		page,
		`activity-ui-${randomUUID()}@example.invalid`,
	);
	const organization = data(
		await workspace.operations(actor.headers, () =>
			createOrganization(workspace.auth, actor.headers, {
				name: "Activity lab",
				slug: `activity-${randomUUID()}`,
			}),
		),
	);
	const project = data(
		await workspace.operations(actor.headers, (actor) =>
			createProject(workspace.database.db, actor, {
				requestId: randomUUID(),
				organizationId: organization.id,
				name: "Telemetry",
			}),
		),
	);
	const descriptor = JSON.parse(
		readFileSync(
			new URL("../../src/activity/generated/descriptors.json", import.meta.url),
			"utf8",
		),
	);
	const root = protobuf.Root.fromJSON(descriptor.schema);
	const pointType = root.lookupType("recount.telemetry.AnalyticalPoint"),
		notificationType = root.lookupType("recount.telemetry.LiveNotification"),
		lineageType = root.lookupType("recount.telemetry.PointLineage"),
		rawType = root.lookupType("recount.telemetry.RawRecord"),
		requestType = root.lookupType(
			"opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
		);
	const kafka = new Kafka({
		clientId: "recount-activity-browser-test",
		brokers: [process.env.RECOUNT_ACTIVITY_KAFKA_BROKERS ?? ""],
		logLevel: logLevel.NOTHING,
	});
	const admin = kafka.admin(),
		producer = kafka.producer();
	const clickhouse = createClient({
		url: process.env.RECOUNT_CLICKHOUSE_TEST_URL,
		username: process.env.RECOUNT_CLICKHOUSE_TEST_USER,
		password: process.env.RECOUNT_CLICKHOUSE_TEST_PASSWORD,
		log: { level: ClickHouseLogLevel.OFF },
	});
	let topicCreated = false,
		inserted = false,
		timer: ReturnType<typeof setInterval> | undefined;
	let producerFailure: unknown;
	let gateway: ChildProcess | undefined;
	const time = BigInt(Date.now()) * 1000000n;
	const connection = {
		connection_id: randomUUID(),
		connected_unix_nano: time.toString(),
		local_address: "192.0.2.10:42100",
		peer_address: "198.51.100.1:4317",
		inventory_observed_unix_nano: time.toString(),
		hostname: "activity-node-1",
		kernel_release: "test-kernel",
		architecture: "aarch64",
		inventory_status: "complete",
		local_interface_names: ["eth0"],
		interfaces: [
			{
				name: "eth0",
				mac_address: "02:00:00:00:00:01",
				addresses: ["192.0.2.10"],
				up: true,
			},
		],
	};
	try {
		await admin.connect();
		topicCreated = await admin.createTopics({
			topics: [
				{
					topic,
					numPartitions: 1,
					replicationFactor: 1,
					configEntries: [
						{ name: "max.message.bytes", value: "6291456" },
						{ name: "retention.ms", value: "3600000" },
					],
				},
				{
					topic: liveTopic,
					numPartitions: Number(process.env.RECOUNT_LIVE_PARTITIONS),
					replicationFactor: 1,
					configEntries: [
						{ name: "max.message.bytes", value: "65536" },
						{ name: "retention.ms", value: "300000" },
					],
				},
			],
			waitForLeaders: true,
		});
		if (!topicCreated) throw new Error("Activity test topic was not fresh");
		gateway = spawn(
			"bun",
			["--no-env-file", "apps/web/scripts/live-gateway.ts"],
			{
				cwd: new URL("../../../../", import.meta.url),
				env: {
					...process.env,
					RECOUNT_LIVE_GATEWAY_PORT: new URL(
						process.env.RECOUNT_LIVE_GATEWAY_URL,
					).port,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let gatewayOutput = "";
		gateway.stdout?.on("data", (chunk) => {
			gatewayOutput += chunk;
		});
		gateway.stderr?.on("data", (chunk) => {
			gatewayOutput += chunk;
		});
		await expect
			.poll(
				async () => {
					if (gateway?.exitCode !== null) throw new Error(gatewayOutput);
					try {
						return (
							await fetch(`${process.env.RECOUNT_LIVE_GATEWAY_URL}/health`, {
								headers: {
									Authorization: `Bearer ${process.env.RECOUNT_LIVE_GATEWAY_SECRET}`,
								},
							})
						).ok;
					} catch {
						return false;
					}
				},
				{ timeout: 15000 },
			)
			.toBe(true);
		const lineage = lineageType
			.encode(
				lineageType.fromObject({
					record_id: randomUUID(),
					received_unix_nano: time.toString(),
					delivery: {
						collector_connection_id: connection.connection_id,
						collector_hostname: connection.hostname,
						collector_local_address: connection.local_address,
						collector_peer_address: connection.peer_address,
						ingestion_peer_address: "203.0.113.1:52100",
						local_interfaces: connection.interfaces,
					},
				}),
			)
			.finish();
		const rows = Array.from({ length: 105 }, (_, index) =>
			pointType
				.encodeDelimited(
					pointType.fromObject({
						project_id: project.id,
						source_id: "activity-test-source",
						resource_id: "activity-node-1",
						resource_kind: 1,
						host_id: "activity-node-1",
						metric_name: "recount.node.memory.total",
						unit: "By",
						metric_kind: 1,
						sample_id: createHash("sha256")
							.update(`${project.id}/${index}`)
							.digest(),
						stream_id: createHash("sha256").update(project.id).digest(),
						time_unix_nano: (time - BigInt(index)).toString(),
						event_day: Number(time / 86400000000000n),
						int_value: "9223372036854775807",
						resource_present: true,
						scope_present: true,
						scope_name: "recount.collector.procfs",
						scope_version: "0.1.0",
						resource_attributes: [
							{ path: "/host.name", kind: 2, string_value: "activity-node-1" },
						],
						point_attributes: [
							{ path: "/opaque", kind: 6, bytes_value: Buffer.from([0, 255]) },
						],
						lineage,
					}),
				)
				.finish(),
		);
		const result = await clickhouse.exec({
			query: "INSERT INTO telemetry.metric_points FORMAT Protobuf",
			values: Readable.from([Buffer.concat(rows)]),
			clickhouse_settings: {
				format_schema: "recount.proto:AnalyticalPoint",
				format_protobuf_use_autogenerated_schema: 0,
			},
		});
		result.stream.resume();
		await finished(result.stream);
		inserted = true;
		const path = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}/activity`;
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(path);
		await expect(
			page.getByRole("heading", {
				name: m.activity_title({}, { locale: "en" }),
				exact: true,
			}),
		).toBeVisible();
		const later = page.getByRole("dialog", {
			name: m.passkey_prompt_title({}, { locale: "en" }),
		});
		if (await later.isVisible())
			await later
				.getByRole("button", {
					name: m.passkey_prompt_later({}, { locale: "en" }),
				})
				.click();
		const table = page.getByRole("table", { name: "Explorer", exact: true });
		await expect(
			page.getByText(/No aggregation or downsampling|Filters are coming later/),
		).toHaveCount(0);
		await expect(table.locator("tbody > tr")).toHaveCount(100);
		// The page header sticks while the table scrolls and shows its separator only then.
		const header = page.locator("[data-stuck]");
		await expect(header).toHaveAttribute("data-stuck", "false");
		await page
			.locator("#main-content")
			.evaluate((main) => main.scrollTo(0, 800));
		await expect(header).toHaveAttribute("data-stuck", "true");
		await expect(
			page.getByRole("heading", { name: "Activity", exact: true }),
		).toBeInViewport();
		await page.screenshot({ path: testInfo.outputPath("activity-sticky.png") });
		await page.locator("#main-content").evaluate((main) => main.scrollTo(0, 0));
		await expect(header).toHaveAttribute("data-stuck", "false");
		await expect(header).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
		const height =
			(await table.locator("tbody > tr").first().boundingBox())?.height ?? 100;
		if (height > 34) {
			await testInfo.attach("row-layout", {
				body: JSON.stringify(
					await table
						.locator("tbody > tr")
						.first()
						.evaluate((row) =>
							Array.from(row.children).map((cell) => ({
								text: cell.textContent,
								height: cell.getBoundingClientRect().height,
								padding: getComputedStyle(cell).padding,
								lineHeight: getComputedStyle(cell).lineHeight,
								children: Array.from(cell.children).map((child) => ({
									tag: child.tagName,
									height: child.getBoundingClientRect().height,
									display: getComputedStyle(child).display,
									lineHeight: getComputedStyle(child).lineHeight,
								})),
							})),
						),
					null,
					2,
				),
				contentType: "application/json",
			});
			await page.screenshot({ path: testInfo.outputPath("row-layout.png") });
		}
		expect(height).toBeLessThanOrEqual(34);
		expect(
			(
				await page
					.getByRole("button", { name: "Reload", exact: true })
					.boundingBox()
			)?.height,
		).toBe(32);
		expect(
			await page
				.getByRole("heading", { name: "Activity", exact: true })
				.evaluate((heading) => getComputedStyle(heading).fontSize),
		).toBe("22px");
		await expect(
			page.getByRole("button", { name: "Select a metric", exact: true }),
		).toBeDisabled();
		await expect(
			page.getByRole("button", { name: "Attribute filters", exact: true }),
		).toBeDisabled();
		await page.screenshot({
			path: testInfo.outputPath("activity-explorer.png"),
		});
		await page
			.getByRole("button", {
				name: "Inspect recount.node.memory.total",
				exact: true,
			})
			.first()
			.click();
		await expect(
			page
				.getByRole("tabpanel")
				.getByText('"9223372036854775807"', { exact: true }),
		).toBeVisible();
		await page.getByRole("tab", { name: "Attributes", exact: true }).click();
		await expect(
			page.getByRole("tabpanel").getByText('"AP8="', { exact: true }),
		).toBeVisible();
		await page.screenshot({
			path: testInfo.outputPath("activity-explorer-inspector.png"),
		});
		await page
			.getByRole("tab", { name: "Node diagnostics", exact: true })
			.click();
		await expect(
			page
				.getByRole("tabpanel")
				.getByText('"192.0.2.10:42100"', { exact: true }),
		).toBeVisible();
		await page
			.getByRole("button", {
				name: "Inspect recount.node.memory.total",
				exact: true,
			})
			.first()
			.click();
		await page
			.getByRole("button", { name: "Older measurements", exact: true })
			.click();
		await expect(table.locator("tbody > tr")).toHaveCount(5);
		await page
			.getByRole("button", { name: "Newest measurements", exact: true })
			.click();
		await expect(table.locator("tbody > tr")).toHaveCount(100);
		await page
			.getByRole("button", { name: "Configure columns", exact: true })
			.click();
		await page
			.getByRole("menuitemcheckbox", { name: "Resource", exact: true })
			.click();
		await page.keyboard.press("Escape");
		await expect(
			table.getByRole("columnheader", { name: "Resource", exact: true }),
		).toHaveCount(0);
		await producer.connect();
		const publish = async () => {
			const recordId = randomUUID();
			const now = (BigInt(Date.now()) * 1000000n).toString();
			const request = requestType
				.encode(
					requestType.fromObject({
						resource_metrics: [
							{
								resource: {
									attributes: [
										{
											key: "host.name",
											value: { string_value: "activity-node-1" },
										},
									],
								},
								scope_metrics: [
									{
										metrics: [
											{
												name: "recount.node.memory.total",
												unit: "By",
												gauge: {
													data_points: [
														{
															time_unix_nano: now,
															as_int: "9223372036854775807",
														},
													],
												},
											},
										],
									},
								],
							},
						],
					}),
				)
				.finish();
			const raw = rawType
				.encode(
					rawType.fromObject({
						security: {
							project_id: project.id,
							source_id: "activity-test-source",
						},
						record_id: recordId,
						received_unix_nano: now,
						payload_kind: 1,
						batch: { client_id: randomUUID(), created_unix_nano: now },
						otlp_request: request,
						bindings: [
							{
								context: {
									resource: { id: "activity-node-1", kind: 1 },
									host_id: "activity-node-1",
								},
							},
						],
						delivery: {
							collector: connection,
							ingestion_peer_address: "203.0.113.1:52100",
						},
					}),
				)
				.finish();
			const location = (
				await producer.send({ topic, messages: [{ value: Buffer.from(raw) }] })
			)[0];
			const projectId = project.id;
			const notification = notificationType
				.encode(
					notificationType.fromObject({
						project_id: projectId,
						source_id: "activity-test-source",
						record_id: recordId,
						received_unix_nano: now,
						measured_unix_nano: now,
						nodes: [
							{
								id: "activity-node-1",
								name: "activity-node-1",
								measured_unix_nano: now,
							},
						],
						resources: 1,
						metrics: 1,
						points: 1,
						bytes: raw.length,
						raw_partition: location.partition,
						raw_offset: location.baseOffset,
					}),
				)
				.finish();
			await producer.send({
				topic: liveTopic,
				messages: [
					{
						partition:
							createHash("sha256").update(projectId).digest().readUInt32BE(0) %
							Number(process.env.RECOUNT_LIVE_PARTITIONS),
						key: projectId,
						value: Buffer.from(notification),
					},
				],
			});
		};
		timer = setInterval(
			() =>
				void publish().catch((error) => {
					producerFailure = error;
				}),
			1000,
		);
		await page.getByRole("link", { name: "Live", exact: true }).click();
		await expect(
			page.getByRole("status").filter({ hasText: "Connected" }),
		).toBeVisible({ timeout: 15000 });
		const live = page.getByRole("table", { name: "Live", exact: true });
		await expect(
			live.getByRole("button", { name: /^Inspect / }).first(),
		).toBeVisible({ timeout: 15000 });
		await expect(
			page.getByText("Nodes reporting: 1", { exact: true }),
		).toBeVisible();
		expect(
			(await live.locator("tbody > tr").first().boundingBox())?.height ?? 100,
		).toBeLessThanOrEqual(34);
		await page.getByRole("button", { name: "Pause", exact: true }).click();
		const frozen = await live.locator("tbody").innerText();
		await page.waitForTimeout(2300);
		expect(await live.locator("tbody").innerText()).toBe(frozen);
		await live
			.getByRole("button", { name: /^Inspect / })
			.first()
			.click();
		await expect(
			page.getByRole("tab", { name: "Node diagnostics", exact: true }),
		).toBeVisible();
		const json = page.getByRole("tree", {
			name: "Inspect collector",
			exact: true,
		});
		await json
			.getByRole("button", { name: "Expand JSON", exact: true })
			.first()
			.click();
		await expect(
			json.getByText('"192.0.2.10:42100"', { exact: true }),
		).toBeVisible();
		await page.screenshot({
			path: testInfo.outputPath("activity-live-inspector.png"),
		});
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: "fr", url: workspace.origin },
			]);
		await page.reload();
		await expect(
			page.getByRole("heading", { name: "Activité", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Filtrer par nœud", exact: true }),
		).toBeDisabled();
		await page
			.context()
			.addCookies([
				{ name: "recount_theme", value: "tide-dark", url: workspace.origin },
			]);
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute(
			"data-theme",
			"tide-dark",
		);
		await page.screenshot({
			path: testInfo.outputPath("activity-live-french-dark.png"),
		});
		expect(producerFailure).toBeUndefined();
		expect(errors).toEqual([]);
	} finally {
		clearInterval(timer);
		if (gateway && gateway.exitCode === null) {
			gateway.kill("SIGTERM");
			await once(gateway, "exit");
		}
		await producer.disconnect();
		if (topicCreated) await admin.deleteTopics({ topics: [topic, liveTopic] });
		await admin.disconnect();
		if (inserted)
			await clickhouse.command({
				query:
					"ALTER TABLE telemetry.metric_points DELETE WHERE project_id={project:String} SETTINGS mutations_sync=1",
				query_params: { project: project.id },
			});
		await clickhouse.close();
	}
});
