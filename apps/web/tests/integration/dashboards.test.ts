import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
	addTiles,
	deleteDashboard,
	getDashboard,
	listDashboards,
	removeTile,
	saveDashboard,
	updateLayout,
} from "../../src/analytics/dashboards.server";
import {
	parseLayout,
	parseSaveDashboard,
} from "../../src/analytics/dashboards-validation";
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
import { member, projectMember } from "../../src/db/schema";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { trustedActor } from "../auth-actors";
import { createTestDatabase } from "../database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
const codes = new Map<string, string>();
beforeAll(async () => {
	database = await createTestDatabase("dashboards");
	auth = createAuth(
		{
			origin: "http://localhost:3001",
			rpID: "localhost",
			secret: `dashboards-test-${randomUUID()}`,
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

const draft = encodeDraft({
	...DEFAULT_DRAFT,
	series: [{ ...newSeries("A"), metric: "recount.node.cpu.time" }],
});

test("members arrange dashboards of their project's insights; viewers only open them", async () => {
	const headers = new Headers({ origin: "http://localhost:3001" });
	const actor = (name: string) =>
		trustedActor(
			auth,
			`dashboards-${name}-${randomUUID()}@example.invalid`,
			(email) => codes.get(email),
			headers,
		);
	const owner = await actor("owner");
	const writer = await actor("writer");
	const viewer = await actor("viewer");
	const outsider = await actor("outsider");
	const organization = await createOrganization(auth, owner.headers, {
		name: "Dashboards",
		slug: `dashboards-${randomUUID()}`,
	});
	const createIn = (name: string) =>
		createProject(
			database.db,
			{ id: owner.id },
			{ requestId: randomUUID(), organizationId: organization.id, name },
		);
	const project = await createIn("Fleet");
	const other = await createIn("Other");
	const reference = { organizationId: organization.id, projectId: project.id };
	const memberIds = new Map<string, string>();
	for (const [account, role] of [
		[writer, "member"],
		[viewer, "viewer"],
	] as const) {
		const memberId = randomUUID();
		memberIds.set(account.id, memberId);
		await database.db.insert(member).values({
			id: memberId,
			organizationId: organization.id,
			userId: account.id,
			role: "member",
			createdAt: new Date(),
		});
		await database.db
			.insert(projectMember)
			.values({ ...reference, memberId, role });
	}
	const db = database.db;
	const insight = (name: string, projectId = project.id) =>
		saveInsight(
			db,
			{ id: owner.id },
			{ ...reference, projectId, insightId: randomUUID(), name, draft },
		);
	const [cpu, memory, foreign] = await Promise.all([
		insight("CPU"),
		insight("Memory"),
		insight("Elsewhere", other.id),
	]);

	const dashboardId = randomUUID();
	const target = { ...reference, dashboardId };
	await expect(
		saveDashboard(db, { id: viewer.id }, { ...target, name: "Fleet" }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await saveDashboard(db, { id: writer.id }, { ...target, name: "Fleet" });
	// A retried create stores one dashboard.
	await saveDashboard(db, { id: writer.id }, { ...target, name: "Fleet" });
	expect(await listDashboards(db, { id: viewer.id }, reference)).toMatchObject([
		{ id: dashboardId, name: "Fleet", tileCount: 0 },
	]);

	// Tiles only show insights of the dashboard's own project.
	await expect(
		addTiles(db, { id: writer.id }, { ...target, insightIds: [foreign.id] }),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		addTiles(db, { id: viewer.id }, { ...target, insightIds: [cpu.id] }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const added = await addTiles(
		db,
		{ id: writer.id },
		{ ...target, insightIds: [cpu.id, memory.id] },
	);
	expect(added.tiles.map((tile) => tile.insight.name)).toEqual([
		"CPU",
		"Memory",
	]);

	// A layout reorders, resizes and places every tile together.
	const [first, second] = added.tiles;
	const arranged = await updateLayout(
		db,
		{ id: writer.id },
		{
			...target,
			tiles: [
				{ id: second.id, width: 12, height: 1, column: null },
				{ id: first.id, width: 5, height: 6, column: 8 },
			],
		},
	);
	expect(
		arranged.tiles.map(({ insight, width, height, column }) => [
			insight.name,
			width,
			height,
			column,
		]),
	).toEqual([
		["Memory", 12, 1, null],
		["CPU", 5, 6, 8],
	]);
	// A tile must fit the grid from its start column.
	for (const tile of [
		{ id: first.id, width: 5, height: 2, column: 9 },
		{ id: first.id, width: 2, height: 2, column: null },
		{ id: first.id, width: 6, height: 7, column: null },
	])
		expect(() => parseLayout({ ...target, tiles: [{ ...tile }] })).toThrow();
	// A layout from a stale page, missing a tile, is refused rather than applied.
	await expect(
		updateLayout(
			db,
			{ id: writer.id },
			{
				...target,
				tiles: [{ id: first.id, width: 6, height: 2, column: null }],
			},
		),
	).rejects.toMatchObject({ code: "CONFLICT" });

	// Saved overrides apply to every tile and are stored normalized; invalid ones are
	// refused, and an empty set returns to each insight's own settings.
	const overrides = parseSaveDashboard({
		...target,
		name: "Fleet",
		filters: JSON.stringify({
			interval: "5m",
			breakdown: "node",
			range: { kind: "last", count: 24, unit: "hours" },
			filters: [
				{ field: 'attributes["cpu.mode"]', op: "eq", values: ["user"] },
			],
			compare: null,
		}),
	});
	const saved = await saveDashboard(db, { id: writer.id }, overrides);
	expect(JSON.parse(saved.filters)).toEqual({
		range: { kind: "last", count: 24, unit: "hours" },
		interval: "5m",
		filters: [{ field: 'attributes["cpu.mode"]', op: "eq", values: ["user"] }],
		breakdown: "node",
		compare: null,
	});
	for (const invalid of [
		{ range: { kind: "never" } },
		{ interval: "2m" },
		{ breakdown: "secret" },
		{ unknown: true },
	])
		expect(() =>
			parseSaveDashboard({
				...target,
				name: "Fleet",
				filters: JSON.stringify(invalid),
			}),
		).toThrow();
	expect(
		(
			await saveDashboard(
				db,
				{ id: writer.id },
				{ ...target, name: "Fleet", filters: "{}" },
			)
		).filters,
	).toBe("{}");

	// Deleting an insight removes its tile; removing a tile keeps the insight.
	await deleteInsights(
		db,
		{ id: owner.id },
		{ ...reference, insightIds: [cpu.id] },
	);
	const opened = await getDashboard(db, { id: viewer.id }, target);
	expect(opened.tiles.map((tile) => tile.insight.name)).toEqual(["Memory"]);
	await removeTile(db, { id: writer.id }, { ...target, tileId: second.id });
	expect((await getDashboard(db, { id: writer.id }, target)).tiles).toEqual([]);

	// The dashboard stays inside its project and organization.
	await expect(
		getDashboard(db, { id: owner.id }, { ...target, projectId: other.id }),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		getDashboard(db, { id: outsider.id }, target),
	).rejects.toMatchObject({ code: "NOT_FOUND" });

	// Losing project access closes the dashboard at once.
	await database.db
		.delete(projectMember)
		.where(eq(projectMember.memberId, memberIds.get(viewer.id) as string));
	await expect(
		getDashboard(db, { id: viewer.id }, target),
	).rejects.toMatchObject({ code: "NOT_FOUND" });

	await expect(
		deleteDashboard(db, { id: viewer.id }, target),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await deleteDashboard(db, { id: writer.id }, target);
	expect(await listDashboards(db, { id: writer.id }, reference)).toEqual([]);
});
