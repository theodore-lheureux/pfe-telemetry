import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { authorizeLive, listPoints } from "../../src/activity/activity.server";
import * as analytics from "../../src/analytics/analytics.server";
import { saveDashboard } from "../../src/analytics/dashboards.server";
import { createAuth } from "../../src/auth/create-auth.server";
import * as executions from "../../src/executions/executions.server";
import { closeTelemetryClient } from "../../src/executions/telemetry.server";
import type { ProjectReference } from "../../src/organizations/contracts";
import { updateProject } from "../../src/organizations/projects.server";
import { createTestDatabase } from "../database";
import {
	expectedProjectError,
	PROJECT_ACTOR_ROLES,
	type ProjectAccess,
	projectRoleScenario,
} from "../project-roles";

const origin = "http://localhost:3001";
const codes = new Map<string, string>();
const environment = [
	"RECOUNT_CLICKHOUSE_URL",
	"RECOUNT_CLICKHOUSE_READER_PASSWORD",
];
const saved = Object.fromEntries(
	environment.map((key) => [key, process.env[key]]),
);
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
let clickhouse: ReturnType<typeof Bun.serve>;
/** Every statement the readers sent to ClickHouse, with its bound project. */
const statements: { project: string | null; query: string }[] = [];

// Answers just enough for each reader to complete, so allowed calls reach the end.
function stubRows(query: string) {
	if (query.includes("SELECT metric_name AS name"))
		return [
			{
				name: "cpu",
				kind: 1,
				temporality: 0,
				monotonic: 2,
				unit: "1",
				description: "",
				firstSeenNs: "0",
				lastSeenNs: "0",
			},
		];
	if (query.includes("SELECT execution_key AS executionKey"))
		return [
			{
				executionKey: "slurm:48213",
				name: "Distributed job",
				workloadVersion: null,
				parameters: [],
				nodeCount: 1,
				participantCount: 1,
				environmentVariables: [],
				firstSeenNs: "0",
				lastSeenNs: "0",
			},
		];
	return [];
}

beforeAll(async () => {
	database = await createTestDatabase("access");
	auth = createAuth(
		{ origin, rpID: "localhost", secret: randomUUID(), allowSignUp: true },
		database.db,
		{
			sendSignInCode: async (email, code) => {
				codes.set(email, code);
			},
			sendOrganizationInvitation: async () => {},
		},
	);
	clickhouse = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const query = url.searchParams.get("query") ?? (await request.text());
			statements.push({
				project: url.searchParams.get("param_project"),
				query,
			});
			return new Response(
				stubRows(query)
					.map((row) => `${JSON.stringify(row)}\n`)
					.join(""),
			);
		},
	});
	// The application's own reader client, so every default read path is captured.
	await closeTelemetryClient();
	process.env.RECOUNT_CLICKHOUSE_URL = `http://127.0.0.1:${clickhouse.port}`;
	process.env.RECOUNT_CLICKHOUSE_READER_PASSWORD = "stub";
});
afterAll(async () => {
	await closeTelemetryClient();
	for (const key of environment)
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	await clickhouse?.stop(true);
	await auth?.emailDelivery.close();
	await database?.close();
});

type Scenario = Awaited<ReturnType<typeof projectRoleScenario>>;
const operations: {
	name: string;
	access: ProjectAccess;
	reads: boolean;
	run: (
		scenario: Scenario,
		headers: Headers,
		reference: ProjectReference,
	) => Promise<{ error: { code: string } | null }>;
}[] = [
	{
		name: "listExecutions",
		access: "read",
		reads: true,
		run: (s, headers, reference) =>
			s.requests(headers, (actor) =>
				executions.listExecutions(database.db, actor, reference),
			),
	},
	{
		name: "getExecution",
		access: "read",
		reads: true,
		run: (s, headers, reference) =>
			s.requests(headers, (actor) =>
				executions.getExecution(database.db, actor, {
					...reference,
					executionKey: "slurm:48213",
				}),
			),
	},
	{
		name: "runAnalyticsQuery",
		access: "read",
		reads: true,
		run: (s, headers, reference) =>
			s.requests(headers, (actor) =>
				analytics.runAnalyticsQuery(database.db, actor, {
					...reference,
					query: {
						shape: "timeseries",
						range: { last: "1h" },
						interval: "1m",
						measures: [
							{ name: "A", metric: "cpu", calculation: "avg", combine: "sum" },
						],
						// Execution grouping joins execution_participants to the points.
						groupBy: ["execution"],
					},
				}),
			),
	},
	{
		name: "analyticsCatalog",
		access: "read",
		reads: true,
		run: (s, headers, reference) =>
			s.requests(headers, (actor) =>
				analytics.analyticsCatalog(database.db, actor, reference),
			),
	},
	{
		name: "metricAttributes",
		access: "read",
		reads: true,
		run: (s, headers, reference) =>
			s.requests(headers, (actor) =>
				analytics.metricAttributes(database.db, actor, {
					...reference,
					metric: "cpu",
				}),
			),
	},
	{
		name: "attributeValues",
		access: "read",
		reads: true,
		run: (s, headers, reference) =>
			s.requests(headers, (actor) =>
				analytics.attributeValues(database.db, actor, {
					...reference,
					metric: "cpu",
					field: 'attributes["cpu.mode"]',
				}),
			),
	},
	{
		name: "listPoints",
		access: "read",
		reads: true,
		run: (s, headers, reference) =>
			s.requests(headers, (actor) => listPoints(database.db, actor, reference)),
	},
	{
		name: "authorizeLive",
		access: "read",
		reads: false,
		run: (s, headers, reference) =>
			s.requests(headers, (actor) =>
				authorizeLive(database.db, actor, reference),
			),
	},
	{
		name: "saveDashboard",
		access: "write",
		reads: false,
		run: (s, headers, reference) =>
			s.requests(headers, (actor) =>
				saveDashboard(database.db, actor, {
					...reference,
					dashboardId: randomUUID(),
					name: "Matrix",
				}),
			),
	},
	{
		name: "updateProject",
		access: "admin",
		reads: false,
		run: (s, headers, reference) =>
			s.requests(headers, (actor) =>
				updateProject(database.db, actor, { ...reference, name: "Private" }),
			),
	},
];

/** A call's error code (or "ok") and whether it reached ClickHouse. */
async function outcome(run: () => Promise<{ error: { code: string } | null }>) {
	const before = statements.length;
	const result = await run();
	const reached = statements.length > before ? "ClickHouse" : "no ClickHouse";
	return `${result.error?.code ?? "ok"}, ${reached}`;
}

const TELEMETRY_TABLES = new Set([
	"metric_points",
	"metric_definitions",
	"attribute_definitions",
	"execution_participants",
]);

/**
 * The tables a statement reads, and those not immediately filtered by the bound
 * project. Common table expressions and subqueries are checked at their own sources.
 */
function projectSources(query: string) {
	const expressions = new Set(
		[...query.matchAll(/(?:\bWITH|,)\s*([a-z_]+)\s+AS\s*\(/gi)]
			.map((match) => match[1])
			.filter((name) => !TELEMETRY_TABLES.has(name)),
	);
	const tables: string[] = [];
	const unfiltered: string[] = [];
	for (const match of query.matchAll(/\b(?:FROM|JOIN)\s+([a-z_.]+)/gi)) {
		if (expressions.has(match[1])) continue;
		tables.push(match[1]);
		const rest = query.slice((match.index ?? 0) + match[0].length);
		if (
			!TELEMETRY_TABLES.has(match[1]) ||
			!/^(?:\s+FINAL)?\s+WHERE\s+project_id\s*=\s*\{project:String\}/i.test(
				rest,
			)
		)
			unfiltered.push(match[1]);
	}
	return { tables, unfiltered };
}

test("every role receives exactly its policy access, and only authorized calls reach ClickHouse", async () => {
	const scenario = await projectRoleScenario(
		auth,
		database,
		(email) => codes.get(email),
		origin,
	);
	const outcomes: Record<string, Record<string, string>> = {};
	const expected: typeof outcomes = {};
	for (const role of PROJECT_ACTOR_ROLES) {
		outcomes[role] = {};
		expected[role] = {};
		for (const operation of operations) {
			outcomes[role][operation.name] = await outcome(() =>
				operation.run(
					scenario,
					scenario.actors[role].headers,
					scenario.reference,
				),
			);
			const error = expectedProjectError(role, operation.access);
			const reached =
				!error && operation.reads ? "ClickHouse" : "no ClickHouse";
			expected[role][operation.name] = `${error ?? "ok"}, ${reached}`;
		}
	}
	expect(outcomes).toEqual(expected);
});

test("ClickHouse sources filter on the authorized project; substituted IDs never reach it", async () => {
	const scenario = await projectRoleScenario(
		auth,
		database,
		(email) => codes.get(email),
		origin,
	);
	const readers = operations.filter((operation) => operation.reads);
	const before = statements.length;
	for (const operation of readers)
		expect(
			(
				await operation.run(
					scenario,
					scenario.actors["project viewer"].headers,
					scenario.reference,
				)
			).error,
		).toBeNull();
	const authorized = statements.slice(before);
	expect(authorized.length).toBeGreaterThanOrEqual(readers.length);
	const read = new Set<string>();
	for (const statement of authorized) {
		expect(statement.project).toBe(scenario.reference.projectId);
		const { tables, unfiltered } = projectSources(statement.query);
		expect(tables.length).toBeGreaterThan(0);
		expect({ query: statement.query, unfiltered }).toEqual({
			query: statement.query,
			unfiltered: [],
		});
		for (const table of tables) read.add(table);
	}
	expect([...read].sort()).toEqual([...TELEMETRY_TABLES].sort());

	const outcomes: Record<string, string> = {};
	const expected: typeof outcomes = {};
	for (const role of ["project viewer", "project admin"] as const)
		for (const [substitute, reference] of Object.entries(scenario.substitutes))
			for (const operation of operations) {
				const key = `${role} / ${substitute} / ${operation.name}`;
				outcomes[key] = await outcome(() =>
					operation.run(scenario, scenario.actors[role].headers, reference),
				);
				expected[key] = "NOT_FOUND, no ClickHouse";
			}
	expect(outcomes).toEqual(expected);
});
