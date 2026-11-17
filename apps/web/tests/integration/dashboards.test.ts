import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
	dashboardTemplate,
	executionTemplate,
	nodeHealthTemplate,
} from "../../src/analytics/dashboard-templates";
import {
	createTemplateDashboard,
	listDashboardTemplates,
	saveDashboardTemplate,
} from "../../src/analytics/dashboard-templates.server";
import {
	addTiles,
	copyTile,
	deleteDashboard,
	duplicateTile,
	getDashboard,
	getProjectHome,
	getProjectHomeChoice,
	listDashboards,
	removeTile,
	saveDashboard,
	setProjectHome,
	updateLayout,
	updateTile,
} from "../../src/analytics/dashboards.server";
import {
	parseLayout,
	parseSaveDashboard,
	parseUpdateTile,
} from "../../src/analytics/dashboards-validation";
import {
	DEFAULT_DRAFT,
	decodeDraft,
	encodeDraft,
	newSeries,
	sameDraft,
} from "../../src/analytics/insight/draft";
import {
	deleteInsights,
	saveInsight,
} from "../../src/analytics/saved-insights.server";
import { createAuth } from "../../src/auth/create-auth.server";
import {
	collectorNode,
	enrollmentKey,
	member,
	projectMember,
} from "../../src/db/schema";
import { getExecution } from "../../src/executions/executions.server";
import type {
	readExecutionFacts,
	readExecutions,
} from "../../src/executions/participants.server";
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

	const templateTarget = {
		...reference,
		dashboardId: randomUUID(),
		templateId: "node-health",
	};
	await expect(
		createTemplateDashboard(db, { id: viewer.id }, templateTarget),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		createTemplateDashboard(db, { id: outsider.id }, templateTarget),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	const [nodeHealth, retried] = await Promise.all([
		createTemplateDashboard(db, { id: writer.id }, templateTarget),
		createTemplateDashboard(db, { id: writer.id }, templateTarget),
	]);
	const template = nodeHealthTemplate();
	expect(nodeHealth).toMatchObject({
		name: template.name,
		description: template.description,
		filters: template.filters,
	});
	for (const [index, tile] of nodeHealth.tiles.entries()) {
		const expected = template.tiles[index];
		const { draft: expectedDraft, ...insight } = expected.insight;
		expect(tile).toMatchObject({ ...expected, insight });
		expect(
			sameDraft(decodeDraft(tile.insight.draft), decodeDraft(expectedDraft)),
		).toBe(true);
	}
	expect(retried.tiles.map((tile) => tile.insight.id)).toEqual(
		nodeHealth.tiles.map((tile) => tile.insight.id),
	);
	expect(nodeHealth.tiles).toHaveLength(6);
	await saveInsight(
		db,
		{ id: writer.id },
		{
			...reference,
			insightId: nodeHealth.tiles[0].insight.id,
			name: "Customized CPU",
		},
	);
	const afterRetry = await createTemplateDashboard(
		db,
		{ id: writer.id },
		templateTarget,
	);
	expect(afterRetry.tiles[0].insight.name).toBe("Customized CPU");
	const independent = await createTemplateDashboard(
		db,
		{ id: writer.id },
		{ ...templateTarget, dashboardId: randomUUID() },
	);
	expect(independent.tiles[0].insight.id).not.toBe(
		nodeHealth.tiles[0].insight.id,
	);
	expect(independent.tiles[0].insight.name).toBe(
		nodeHealthTemplate().tiles[0].insight.name,
	);
	await expect(
		createTemplateDashboard(
			db,
			{ id: owner.id },
			{ ...templateTarget, projectId: other.id },
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	const nodeId = randomUUID();
	const keyId = randomUUID();
	await db.insert(enrollmentKey).values({
		id: keyId,
		...reference,
		name: "Template nodes",
		keySha256: "a".repeat(64),
	});
	await db.insert(collectorNode).values({
		id: nodeId,
		...reference,
		enrollmentKeyId: keyId,
		machineId: "template-node",
		hostname: "Template node",
		publicKey: "a".repeat(43),
	});
	const filledTarget = {
		...reference,
		dashboardId: randomUUID(),
		templateId: "node-health",
		values: { $node: nodeId },
	};
	const filled = await createTemplateDashboard(
		db,
		{ id: writer.id },
		filledTarget,
	);
	expect(JSON.parse(filled.filters)).toEqual({
		filters: [{ field: "node", op: "eq", values: [nodeId] }],
	});
	await expect(
		createTemplateDashboard(
			db,
			{ id: writer.id },
			{
				...filledTarget,
				dashboardId: randomUUID(),
				values: { $node: randomUUID() },
			},
		),
	).rejects.toMatchObject({ reason: "INVALID_QUERY" });
	await updateTile(
		db,
		{ id: writer.id },
		{
			...filledTarget,
			tileId: filled.tiles[0].id,
			options: { color: "purple" },
			overrides: '{"interval":"5m"}',
		},
	);
	const snapshotInput = {
		...filledTarget,
		templateId: randomUUID(),
		name: "Team health",
		description: "Custom snapshot",
		parameterizeNode: true,
	};
	await expect(
		saveDashboardTemplate(db, { id: viewer.id }, snapshotInput),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		saveDashboardTemplate(db, { id: outsider.id }, snapshotInput),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		saveDashboardTemplate(
			db,
			{ id: owner.id },
			{ ...snapshotInput, projectId: other.id },
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await saveDashboardTemplate(db, { id: writer.id }, snapshotInput);
	await saveDashboardTemplate(db, { id: writer.id }, snapshotInput);
	const templates = await listDashboardTemplates(
		db,
		{ id: viewer.id },
		reference,
	);
	expect(templates).toHaveLength(1);
	expect(templates[0].template).toMatchObject({
		name: "Team health",
		filters: "{}",
		variables: [{ name: "$node", field: "node" }],
	});
	expect(templates[0].template.tiles[0]).toMatchObject({
		options: { color: "purple" },
		overrides: '{"interval":"5m"}',
	});
	expect(
		await listDashboardTemplates(
			db,
			{ id: owner.id },
			{ ...reference, projectId: other.id },
		),
	).toEqual([]);
	await expect(
		listDashboardTemplates(db, { id: outsider.id }, reference),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await deleteDashboard(db, { id: writer.id }, filledTarget);
	await deleteInsights(
		db,
		{ id: writer.id },
		{ ...reference, insightIds: filled.tiles.map((tile) => tile.insight.id) },
	);
	const fromSnapshot = {
		...reference,
		dashboardId: randomUUID(),
		templateId: snapshotInput.templateId,
		values: { $node: nodeId },
	};
	const restored = await createTemplateDashboard(
		db,
		{ id: writer.id },
		fromSnapshot,
	);
	expect(restored.name).toBe("Team health");
	expect(restored.tiles).toHaveLength(6);
	expect(restored.tiles[0].options).toEqual({ color: "purple" });
	expect(restored.tiles[0].insight.id).not.toBe(filled.tiles[0].insight.id);
	expect(dashboardTemplate(restored).tiles).toEqual(
		templates[0].template.tiles,
	);
	await expect(
		createTemplateDashboard(
			db,
			{ id: viewer.id },
			{ ...fromSnapshot, dashboardId: randomUUID() },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		createTemplateDashboard(
			db,
			{ id: owner.id },
			{ ...fromSnapshot, projectId: other.id, dashboardId: randomUUID() },
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await deleteDashboard(db, { id: writer.id }, fromSnapshot);
	await deleteDashboard(db, { id: writer.id }, templateTarget);
	await deleteDashboard(
		db,
		{ id: writer.id },
		{ ...reference, dashboardId: independent.id },
	);

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
				{ id: second.id, width: 2, height: 0, column: 11 },
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
		["Memory", 2, 0, 11],
		["CPU", 5, 6, 8],
	]);
	// A tile must fit the grid from its start column.
	for (const tile of [
		{ id: first.id, width: 5, height: 2, column: 9 },
		{ id: first.id, width: 1, height: 2, column: null },
		{ id: first.id, width: 2, height: -1, column: null },
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

	// A tile keeps its own overrides and options; invalid ones are refused.
	const tuned = await updateTile(
		db,
		{ id: writer.id },
		parseUpdateTile({
			...target,
			tileId: first.id,
			overrides: JSON.stringify({ interval: "1h", ignoreDashboard: true }),
			options: { color: "green", hideDescription: true },
		}),
	);
	const tunedTile = tuned.tiles.find((tile) => tile.id === first.id);
	expect(JSON.parse(tunedTile?.overrides ?? "{}")).toEqual({
		ignoreDashboard: true,
		interval: "1h",
	});
	expect(tunedTile?.options).toEqual({ hideDescription: true, color: "green" });
	for (const invalid of [
		{ overrides: '{"interval":"2m"}' },
		{ overrides: '{"ignoreDashboard":"yes"}' },
		{ options: { color: "teal" } },
	])
		expect(() =>
			parseUpdateTile({ ...target, tileId: first.id, ...invalid }),
		).toThrow();
	await expect(
		updateTile(
			db,
			{ id: viewer.id },
			{ ...target, tileId: first.id, options: {} },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });

	// Duplicating saves a copy of the insight and adds it with the tile's settings.
	const duplicated = await duplicateTile(
		db,
		{ id: writer.id },
		{ ...target, tileId: first.id, name: "CPU (copy)" },
	);
	const copy = duplicated.tiles.at(-1);
	if (!copy) throw new Error("The copy is missing");
	expect(copy.insight.name).toBe("CPU (copy)");
	expect(copy.insight.id).not.toBe(cpu.id);
	expect(copy.options).toEqual({ hideDescription: true, color: "green" });

	// Tiles copy or move only to another dashboard of the same project.
	const archive = { ...reference, dashboardId: randomUUID() };
	await saveDashboard(db, { id: writer.id }, { ...archive, name: "Archive" });
	await copyTile(
		db,
		{ id: writer.id },
		{
			...target,
			tileId: second.id,
			targetDashboardId: archive.dashboardId,
			move: false,
		},
	);
	const moved = await copyTile(
		db,
		{ id: writer.id },
		{
			...target,
			tileId: copy.id,
			targetDashboardId: archive.dashboardId,
			move: true,
		},
	);
	expect(moved.tiles.map((tile) => tile.id)).not.toContain(copy.id);
	expect(
		(await getDashboard(db, { id: writer.id }, archive)).tiles.map(
			(tile) => tile.insight.name,
		),
	).toEqual(["Memory", "CPU (copy)"]);
	await expect(
		copyTile(
			db,
			{ id: writer.id },
			{
				...target,
				tileId: second.id,
				targetDashboardId: randomUUID(),
				move: false,
			},
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await deleteDashboard(db, { id: writer.id }, archive);

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
		listDashboardTemplates(db, { id: viewer.id }, reference),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		createTemplateDashboard(
			db,
			{ id: viewer.id },
			{
				...reference,
				dashboardId: randomUUID(),
				templateId: snapshotInput.templateId,
			},
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });

	await expect(
		deleteDashboard(db, { id: viewer.id }, target),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	// Admins choose the dashboard the project opens on; members only read it.
	expect(await getProjectHome(db, { id: writer.id }, reference)).toBeNull();
	await expect(
		setProjectHome(db, { id: writer.id }, { ...reference, dashboardId }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const elsewhere = randomUUID();
	await saveDashboard(
		db,
		{ id: owner.id },
		{
			...reference,
			projectId: other.id,
			dashboardId: elsewhere,
			name: "Other",
		},
	);
	await expect(
		setProjectHome(
			db,
			{ id: owner.id },
			{ ...reference, dashboardId: elsewhere },
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await setProjectHome(db, { id: owner.id }, { ...reference, dashboardId });
	expect((await getProjectHome(db, { id: writer.id }, reference))?.id).toBe(
		dashboardId,
	);

	await deleteDashboard(db, { id: writer.id }, target);
	expect(await listDashboards(db, { id: writer.id }, reference)).toEqual([]);
	// Deleting the home dashboard returns the project to the Node health template.
	expect(
		await getProjectHomeChoice(db, { id: writer.id }, reference),
	).toBeNull();
});

test("execution dashboards resolve the execution in its own project, after access checks and before saving", async () => {
	const headers = new Headers({ origin: "http://localhost:3001" });
	const actor = (name: string) =>
		trustedActor(
			auth,
			`execution-dashboards-${name}-${randomUUID()}@example.invalid`,
			(email) => codes.get(email),
			headers,
		);
	const [owner, writer, viewer, outsider] = await Promise.all(
		["owner", "writer", "viewer", "outsider"].map(actor),
	);
	const organization = await createOrganization(auth, owner.headers, {
		name: "Execution dashboards",
		slug: `execution-dashboards-${randomUUID()}`,
	});
	const createIn = (name: string) =>
		createProject(
			database.db,
			{ id: owner.id },
			{ requestId: randomUUID(), organizationId: organization.id, name },
		);
	const project = await createIn("Runs");
	const other = await createIn("Other runs");
	const reference = { organizationId: organization.id, projectId: project.id };
	for (const [account, role] of [
		[writer, "member"],
		[viewer, "viewer"],
	] as const) {
		const memberId = randomUUID();
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
	const entry = {
		executionKey: "slurm:48213",
		name: "Distributed job",
		workloadVersion: null,
		parameters: {},
		nodeCount: 2,
		participantCount: 2,
		environmentVariables: ["SLURM_JOB_ID"],
		firstSeen: new Date("2026-11-03T10:00:00Z"),
		lastSeen: new Date("2026-11-03T11:00:00Z"),
	};
	const nodes = [randomUUID(), randomUUID()].sort();
	let reads = 0;
	// The execution exists only in the first project.
	const read: typeof readExecutions = async (projectId, selector = {}) => {
		reads++;
		return projectId === project.id &&
			selector.executionKey === entry.executionKey
			? [entry]
			: [];
	};
	const readFacts: typeof readExecutionFacts = async (projectId, key) => {
		reads++;
		expect([projectId, key]).toEqual([project.id, entry.executionKey]);
		return nodes.map((nodeId) => ({
			nodeId,
			participantId: randomUUID(),
			factId: randomUUID(),
			kind: 2,
			processResourceId: "process",
			namespaceId: null,
			pid: 1,
			startTimeTicks: null,
			ownerUid: null,
			environmentVariable: "SLURM_JOB_ID",
			firstSeen: entry.firstSeen,
			lastSeen: entry.lastSeen,
			ended: null,
		}));
	};
	const resolve: typeof getExecution = (db, account, input) =>
		getExecution(db, account, input, undefined, read, readFacts);
	const db = database.db;
	const target = {
		...reference,
		dashboardId: randomUUID(),
		templateId: "execution",
		values: { $execution: entry.executionKey },
	};
	const create = (id: string, input = target) =>
		createTemplateDashboard(db, { id }, input, resolve);

	// Viewers read the execution the dashboard is built from, but cannot save one.
	expect(
		(
			await getExecution(
				db,
				{ id: viewer.id },
				{ ...reference, executionKey: entry.executionKey },
				undefined,
				read,
				readFacts,
			)
		).facts,
	).toHaveLength(2);
	reads = 0;
	await expect(create(viewer.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(create(outsider.id)).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
	await expect(
		create(writer.id, { ...target, projectId: other.id }),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		create(writer.id, { ...target, values: { $execution: null } as never }),
	).rejects.toMatchObject({ reason: "INVALID_QUERY" });
	expect(reads).toBe(0);
	// Another project's key and an unknown key are not found, and nothing is saved.
	await expect(
		create(owner.id, { ...target, projectId: other.id }),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		create(writer.id, { ...target, values: { $execution: "slurm:missing" } }),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(await listDashboards(db, { id: owner.id }, reference)).toEqual([]);
	expect(
		await listDashboards(
			db,
			{ id: owner.id },
			{ ...reference, projectId: other.id },
		),
	).toEqual([]);

	const created = await create(writer.id);
	const template = executionTemplate();
	expect(created.name).toBe(template.name);
	expect(JSON.parse(created.filters)).toEqual({
		range: {
			kind: "between",
			from: "2026-11-03T10:00:00.000Z",
			to: "2026-11-03T11:01:00.000Z",
		},
		filters: [{ field: "execution", op: "eq", values: [entry.executionKey] }],
	});
	expect(created.tiles).toHaveLength(template.tiles.length);
	for (const [index, tile] of created.tiles.entries()) {
		const source = template.tiles[index];
		expect(
			sameDraft(
				decodeDraft(tile.insight.draft),
				decodeDraft(source.insight.draft),
			),
		).toBe(true);
		const overrides = JSON.parse(source.overrides);
		expect(JSON.parse(tile.overrides)).toEqual(
			source.executionNodes
				? {
						...overrides,
						filters: [{ field: "node", op: "in", values: nodes }],
					}
				: overrides,
		);
	}
});
