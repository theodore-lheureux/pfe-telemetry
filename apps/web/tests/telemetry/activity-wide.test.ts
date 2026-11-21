import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { readPoint, readPoints } from "../../src/activity/points.server";
import {
	createPointFixture,
	from,
	insertPoints,
	ms,
	stringNode,
} from "./fixture";

test("Explorer hydrates a page and a detail from 80,000 wide series", async () => {
	const fixture = await createPointFixture();
	try {
		const projectId = randomUUID();
		const time = ms + 60_000n;
		const metric = "recount.node.memory.total";
		await fixture.client.command({
			query: insertPoints(
				{
					resource_id: "concat('resource-', leftPad(toString(number), 5, '0'))",
					resource_attributes: `[${stringNode("/host.name", "'wide-node'")},${stringNode("/custom", "repeat(hex(SHA256(toString(number))), 16)")}]`,
					stream_id: "substring(SHA256(toString(number)),1,16)",
					raw_offset: "toUInt64(1)",
					received_unix_nano: "{time:UInt64} * 1000000",
				},
				"CROSS JOIN numbers(80000) AS samples",
			),
			query_params: {
				project: projectId,
				source: "wide-source",
				host: "wide-host",
				time: time.toString(),
				sample: "wide",
				integer: "1",
			},
		});
		await fixture.client.command({ query: "SYSTEM STOP MERGES metric_series" });
		// Keep overlapping parts like those produced by successive Kafka inserts.
		for (let part = 0; part < 11; part++) {
			await fixture.client.command({
				query: `INSERT INTO metric_series SELECT * FROM metric_series WHERE project_id={project:String} AND _part IN (SELECT _part FROM metric_series WHERE project_id={project:String} LIMIT 1)`,
				query_params: { project: projectId },
				clickhouse_settings: {
					max_threads: 1,
					max_insert_threads: "1",
					max_block_size: "4096",
				},
			});
		}
		const reader = profile(fixture.reader);
		const input = {
			projectId,
			organizationId: "organization",
			metric,
			from,
			to: new Date(Number(time + 1000n)),
		};
		const page = await readPoints(input, undefined, reader);
		expect(page.points).toHaveLength(100);
		const first = page.points[0];
		expect(first.node?.name).toBe("wide-host");
		const field = 'resource.attributes["custom"]';
		const projected = await readPoints(
			{ ...input, fields: [field, 'resource.attributes["host.name"]'] },
			undefined,
			reader,
		);
		expect(projected.points[0]?.fields[field]).toHaveLength(1024);
		expect(projected.points[0]?.node?.name).toBe("wide-node");
		const detail = await readPoint(
			{
				...input,
				sampleId: first.sampleId,
				timeMs: first.timeMs,
				sourceId: first.sourceId,
				resourceId: first.resourceId,
				metricName: metric,
			},
			undefined,
			reader,
		);
		expect(detail.provenance.raw_offset).toBe("1");
	} finally {
		await fixture.close();
	}
}, 30_000);

function profile(client: ClickHouseClient): ClickHouseClient {
	if (!process.env.RECOUNT_TEST_ACTIVITY_PROFILE) return client;
	return new Proxy(client, {
		get(target, property) {
			if (property !== "query") return Reflect.get(target, property);
			return async (...args: Parameters<ClickHouseClient["query"]>) => {
				const [request] = args;
				const query = request.query.trim().split("\n")[0].slice(0, 100);
				try {
					const result = await target.query(...args);
					console.log(
						"activity-profile",
						query,
						result.response_headers["x-clickhouse-summary"],
					);
					return Object.assign(result, {
						json: async () => {
							try {
								return await Object.getPrototypeOf(result).json.call(result);
							} catch (error) {
								console.log("activity-profile", query, String(error));
								throw error;
							}
						},
					});
				} catch (error) {
					console.log("activity-profile", query, String(error));
					throw error;
				}
			};
		},
	});
}
