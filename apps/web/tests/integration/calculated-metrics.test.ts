import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { runAnalyticsQuery } from "../../src/analytics/analytics.server";
import {
	builtInCalculations,
	calculatedReference,
} from "../../src/analytics/calculated-metrics";
import {
	deleteCalculation,
	getCalculation,
	parseDeleteCalculation,
	parseSaveCalculation,
	saveCalculation,
} from "../../src/analytics/calculated-metrics.server";
import type {
	AnalyticsQuery,
	MetricDefinition,
	QueryResult,
	SeriesResult,
} from "../../src/analytics/contracts";
import { formulaSeries } from "../../src/analytics/formula-series";
import {
	DEFAULT_DRAFT,
	encodeDraft,
	newSeries,
} from "../../src/analytics/insight/draft";
import {
	deleteInsights,
	saveInsight,
} from "../../src/analytics/saved-insights.server";
import { createAuth } from "../../src/auth/create-auth.server";
import {
	member,
	metricAnnotation,
	projectMember,
	savedInsight,
} from "../../src/db/schema";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { trustedActor } from "../auth-actors";
import { createTestDatabase } from "../database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
const codes = new Map<string, string>();
beforeAll(async () => {
	database = await createTestDatabase("calculated");
	auth = createAuth(
		{
			origin: "http://localhost:3001",
			rpID: "localhost",
			secret: `calculated-test-${randomUUID()}`,
			allowSignUp: true,
		},
		database.db,
		{
			sendSignInCode: async (email, code) => {
				codes.set(email, code);
			},
			sendOrganizationInvitation: async () => {},
		},
	);
});
afterAll(async () => {
	await auth?.emailDelivery.close();
	await database?.close();
});

test("calculated metrics enforce project access and preserve references through rename and deletion", async () => {
	const headers = new Headers({ origin: "http://localhost:3001" });
	const actor = (name: string) =>
		trustedActor(
			auth,
			`${name}-${randomUUID()}@example.invalid`,
			(email) => codes.get(email),
			headers,
		);
	const owner = await actor("calculated-owner");
	const viewer = await actor("calculated-viewer");
	const outsider = await actor("calculated-outsider");
	const organization = await createOrganization(auth, owner.headers, {
		name: "Calculated",
		slug: `calculated-${randomUUID()}`,
	});
	const project = await createProject(
		database.db,
		{ id: owner.id },
		{ requestId: randomUUID(), organizationId: organization.id, name: "A" },
	);
	const other = await createProject(
		database.db,
		{ id: owner.id },
		{ requestId: randomUUID(), organizationId: organization.id, name: "B" },
	);
	const reference = { organizationId: organization.id, projectId: project.id };
	const memberId = randomUUID();
	await database.db.insert(member).values({
		id: memberId,
		organizationId: organization.id,
		userId: viewer.id,
		role: "member",
		createdAt: new Date(),
	});
	await database.db
		.insert(projectMember)
		.values({ ...reference, memberId, role: "viewer" });
	const definition = builtInCalculations()[0];
	const input = parseSaveCalculation({
		create: true,
		...reference,
		id: randomUUID(),
		name: "Busy CPU",
		description: "Reusable CPU percentage",
		definition,
	});
	let reads = 0;
	const read: Parameters<typeof saveCalculation>[4] = async (projectId) => {
		reads++;
		expect(projectId).toBe(project.id);
		return new Map(
			definition.inputs.map((input) => [
				input.metric,
				{
					name: input.metric,
					kind: 2,
					temporality: 2,
					monotonic: true,
					behavior: "counter",
					unit: "s",
					description: "",
					firstSeen: new Date(0),
					lastSeen: new Date(0),
				} satisfies MetricDefinition,
			]),
		);
	};
	await expect(
		saveCalculation(database.db, { id: viewer.id }, input, undefined, read),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		saveCalculation(database.db, { id: outsider.id }, input, undefined, read),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(reads).toBe(0);
	const saved = await saveCalculation(
		database.db,
		{ id: owner.id },
		input,
		undefined,
		read,
	);
	const retried = await saveCalculation(
		database.db,
		{ id: owner.id },
		input,
		undefined,
		read,
	);
	expect(retried.id).toBe(saved.id);
	expect(retried.updatedAt).toEqual(saved.updatedAt);
	await expect(
		saveCalculation(
			database.db,
			{ id: owner.id },
			{ ...input, name: "Conflicting create" },
			undefined,
			read,
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	const metric = calculatedReference(saved.id);
	const savedDraft = encodeDraft({
		...DEFAULT_DRAFT,
		series: [
			{ ...newSeries("A"), metric, calculation: "last", combine: "sum" },
		],
	});
	const usingId = randomUUID();
	await saveInsight(
		database.db,
		{ id: owner.id },
		{
			...reference,
			insightId: usingId,
			name: "Uses calculation",
			draft: savedDraft,
		},
	);
	await expect(
		saveInsight(
			database.db,
			{ id: owner.id },
			{
				organizationId: organization.id,
				projectId: other.id,
				insightId: randomUUID(),
				name: "Foreign reference",
				draft: savedDraft,
			},
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(
		await getCalculation(
			database.db,
			{ id: viewer.id },
			{ ...reference, metric },
		),
	).toMatchObject({ name: "Busy CPU", expression: "A / B * 100" });
	await expect(
		getCalculation(
			database.db,
			{ id: owner.id },
			{ organizationId: organization.id, projectId: other.id, metric },
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		getCalculation(database.db, { id: outsider.id }, { ...reference, metric }),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	const renamed = await saveCalculation(
		database.db,
		{ id: owner.id },
		{ ...input, name: "CPU busy share", create: false },
		undefined,
		read,
	);
	expect(renamed.id).toBe(saved.id);
	expect(
		await getCalculation(
			database.db,
			{ id: viewer.id },
			{ ...reference, metric },
		),
	).toMatchObject({ name: "CPU busy share" });
	expect(() => parseSaveCalculation({ ...input, id: definition.id })).toThrow();
	await expect(
		saveCalculation(
			database.db,
			{ id: owner.id },
			{ ...input, id: definition.id },
			undefined,
			read,
		),
	).rejects.toThrow();
	const query: AnalyticsQuery = {
		shape: "timeseries",
		range: { last: "1h" },
		interval: "1m",
		measures: [{ name: "A", metric, calculation: "last", combine: "sum" }],
	};
	let runs = 0;
	const run = async (
		_project: string,
		expanded: AnalyticsQuery,
	): Promise<QueryResult> => {
		runs++;
		const source: SeriesResult[] = expanded.measures.map((measure, index) => ({
			measure: measure.name,
			group: [],
			points: [{ bucketMs: 0, value: index ? 100 : 40 }],
		}));
		return {
			shape: expanded.shape,
			from: new Date(0),
			to: new Date(60_000),
			bucketSeconds: 60,
			groupBy: [],
			measures: expanded.measures.map((measure) => ({
				name: measure.name,
				metric: measure.metric,
				unit: "s",
				calculation: measure.calculation,
			})),
			formulas: expanded.formulas ?? [],
			series: [...source, ...formulaSeries(expanded, source)],
			limited: false,
			compared: null,
			coverage: null,
		};
	};
	const result = await runAnalyticsQuery(
		database.db,
		{ id: viewer.id },
		{ ...reference, query },
		undefined,
		run,
	);
	expect(result.measures).toMatchObject([
		{ metric, label: "CPU busy share", unit: "%" },
	]);
	expect(result.series).toHaveLength(1);
	expect(result.series[0].points[0].value).toBe(40);
	await expect(
		runAnalyticsQuery(
			database.db,
			{ id: owner.id },
			{ organizationId: organization.id, projectId: other.id, query },
			undefined,
			run,
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(runs).toBe(1);
	await expect(
		runAnalyticsQuery(
			database.db,
			{ id: viewer.id },
			{
				...reference,
				query: { ...query, groupBy: ['attributes["cpu.mode"]'] },
			},
			undefined,
			run,
		),
	).rejects.toMatchObject({ reason: "INVALID_QUERY" });
	expect(runs).toBe(1);
	const deletion = { ...reference, id: saved.id };
	await expect(
		deleteCalculation(database.db, { id: viewer.id }, deletion),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		deleteCalculation(database.db, { id: outsider.id }, deletion),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		deleteCalculation(
			database.db,
			{ id: owner.id },
			{ ...deletion, projectId: other.id },
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		deleteCalculation(database.db, { id: owner.id }, deletion),
	).rejects.toMatchObject({ code: "CONFLICT" });
	await expect(
		deleteCalculation(
			database.db,
			{ id: owner.id },
			{ ...deletion, id: saved.id.toUpperCase() },
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(() =>
		parseDeleteCalculation({ ...reference, id: definition.id }),
	).toThrow();
	await database.db.insert(metricAnnotation).values({
		...reference,
		metricName: metric,
		description: "Deletion annotation",
		status: "hidden",
	});
	await deleteInsights(
		database.db,
		{ id: owner.id },
		{ ...reference, insightIds: [usingId] },
	);
	expect(
		await deleteCalculation(database.db, { id: owner.id }, deletion),
	).toEqual({ deleted: true });
	await expect(
		getCalculation(database.db, { id: owner.id }, { ...reference, metric }),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(
		await database.db
			.select()
			.from(metricAnnotation)
			.where(
				and(
					eq(metricAnnotation.projectId, project.id),
					eq(metricAnnotation.metricName, metric),
				),
			),
	).toHaveLength(0);
	await expect(
		saveCalculation(
			database.db,
			{ id: owner.id },
			{ ...input, create: false, name: "Stale edit" },
			undefined,
			read,
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });

	for (let index = 0; index < 3; index++) {
		const raced = await saveCalculation(
			database.db,
			{ id: owner.id },
			{ ...input, id: randomUUID(), create: true, name: `Race ${index}` },
			undefined,
			read,
		);
		const racedMetric = calculatedReference(raced.id);
		const insightId = randomUUID();
		const outcomes = await Promise.allSettled([
			saveInsight(
				database.db,
				{ id: owner.id },
				{
					...reference,
					insightId,
					name: "Concurrent reference",
					draft: encodeDraft({
						...DEFAULT_DRAFT,
						series: [
							{
								...newSeries("A"),
								metric: racedMetric,
								calculation: "last",
								combine: "sum",
							},
						],
					}),
				},
			),
			deleteCalculation(
				database.db,
				{ id: owner.id },
				{ ...reference, id: raced.id },
			),
		]);
		expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(
			true,
		);
		expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(
			false,
		);
		const rows = await database.db
			.select()
			.from(savedInsight)
			.where(eq(savedInsight.id, insightId));
		if (rows.length)
			expect(
				await getCalculation(
					database.db,
					{ id: owner.id },
					{ ...reference, metric: racedMetric },
				),
			).toMatchObject({ id: raced.id });
	}
});
