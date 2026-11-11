import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
	authorizeLive,
	listPoints,
	packetDetail,
	pointDetail,
} from "../../src/activity/activity.server";
import { DEFAULT_COLUMNS } from "../../src/activity/columns";
import { readColumns, saveColumns } from "../../src/activity/columns.server";
import { createAuth } from "../../src/auth/create-auth.server";
import {
	explorerColumnPreference,
	member,
	projectMember,
} from "../../src/db/schema";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { trustedActor } from "../auth-actors";
import { createTestDatabase } from "../database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
const codes = new Map<string, string>();
beforeAll(async () => {
	database = await createTestDatabase("activity");
	auth = createAuth(
		{
			origin: "http://localhost:3001",
			rpID: "localhost",
			secret: `activity-test-${randomUUID()}`,
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

test("all activity operations authorize canonical project access before touching Kafka or ClickHouse, including after revocation", async () => {
	const headers = new Headers({ origin: "http://localhost:3001" });
	const owner = await trustedActor(
		auth,
		`activity-owner-${randomUUID()}@example.invalid`,
		(email) => codes.get(email),
		headers,
	);
	const viewer = await trustedActor(
		auth,
		`activity-viewer-${randomUUID()}@example.invalid`,
		(email) => codes.get(email),
		headers,
	);
	const organization = await createOrganization(auth, owner.headers, {
		name: "Activity",
		slug: `activity-${randomUUID()}`,
	});
	const project = await createProject(
		database.db,
		{ id: owner.id },
		{
			requestId: randomUUID(),
			organizationId: organization.id,
			name: "Private",
		},
	);
	const reference = { organizationId: organization.id, projectId: project.id };
	const membershipId = randomUUID();
	await database.db.insert(member).values({
		id: membershipId,
		organizationId: organization.id,
		userId: viewer.id,
		role: "member",
		createdAt: new Date(),
	});
	let reads = 0;
	const points = async () => {
		reads++;
		return {
			points: [],
			nextCursor: null,
			from: new Date(0),
			to: new Date(3600000),
			searchedTo: new Date(0),
		};
	};
	const detail = async () => {
		reads++;
		return {
			measurement: {},
			attributes: [],
			resource: {},
			instrumentation: {},
			provenance: {},
			raw: {},
		};
	};
	const packet = () => {
		reads++;
		throw new Error("Reader must not run without permission");
	};
	const actor = { id: viewer.id };
	const point = {
		...reference,
		sourceId: "source",
		resourceId: "node",
		metricName: "metric",
		timeNs: "1",
		sampleId: "aa".repeat(32),
	};
	await expect(
		listPoints(database.db, actor, reference, undefined, points),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		pointDetail(database.db, actor, point, undefined, detail),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		authorizeLive(database.db, actor, reference),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		packetDetail(
			database.db,
			actor,
			{ ...reference, packetId: "packet", partition: 0, offset: "0" },
			packet,
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(reads).toBe(0);
	await database.db.insert(projectMember).values({
		projectId: project.id,
		organizationId: organization.id,
		memberId: membershipId,
		role: "viewer",
	});
	await listPoints(database.db, actor, reference, undefined, points);
	await authorizeLive(database.db, actor, reference);
	expect(reads).toBe(1);
	await database.db
		.delete(projectMember)
		.where(eq(projectMember.memberId, membershipId));
	await expect(
		authorizeLive(database.db, actor, reference),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(reads).toBe(1);
	await authorizeLive(database.db, { id: owner.id }, reference);
	expect(reads).toBe(1);
	await expect(
		authorizeLive(
			database.db,
			{ id: owner.id },
			{ ...reference, organizationId: "another-org" },
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("Explorer columns are per member, fall back to the project default, and only administrators set the default", async () => {
	const headers = new Headers({ origin: "http://localhost:3001" });
	const owner = await trustedActor(
		auth,
		`columns-owner-${randomUUID()}@example.invalid`,
		(email) => codes.get(email),
		headers,
	);
	const viewer = await trustedActor(
		auth,
		`columns-viewer-${randomUUID()}@example.invalid`,
		(email) => codes.get(email),
		headers,
	);
	const organization = await createOrganization(auth, owner.headers, {
		name: "Columns",
		slug: `columns-${randomUUID()}`,
	});
	const project = await createProject(
		database.db,
		{ id: owner.id },
		{ requestId: randomUUID(), organizationId: organization.id, name: "Cols" },
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
	await database.db.insert(projectMember).values({
		...reference,
		memberId,
		role: "viewer",
	});
	const db = database.db;
	expect((await readColumns(db, { id: viewer.id }, reference)).columns).toEqual(
		DEFAULT_COLUMNS,
	);
	const mine = [
		{ field: 'attributes["cpu.mode"]', label: "Mode" },
		{ field: "metric" },
	];
	const saved = await saveColumns(
		db,
		{ id: viewer.id },
		{
			...reference,
			columns: mine,
			asDefault: false,
		},
	);
	expect(saved).toMatchObject({ columns: mine, canSetDefault: false });
	await expect(
		saveColumns(
			db,
			{ id: viewer.id },
			{
				...reference,
				columns: mine,
				asDefault: true,
			},
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const shared = [{ field: "metric" }, { field: "time" }];
	await saveColumns(
		db,
		{ id: owner.id },
		{
			...reference,
			columns: shared,
			asDefault: true,
		},
	);
	// The member keeps their own choice; the owner, matching the default, stores none.
	expect((await readColumns(db, { id: viewer.id }, reference)).columns).toEqual(
		mine,
	);
	expect(await readColumns(db, { id: owner.id }, reference)).toMatchObject({
		columns: shared,
		defaults: shared,
		canSetDefault: true,
	});
	// Saving the default again removes the member's own set, so later defaults apply.
	await saveColumns(
		db,
		{ id: viewer.id },
		{
			...reference,
			columns: shared,
			asDefault: false,
		},
	);
	expect(
		await db
			.select()
			.from(explorerColumnPreference)
			.where(eq(explorerColumnPreference.memberId, memberId)),
	).toHaveLength(0);
	await db.delete(projectMember).where(eq(projectMember.memberId, memberId));
	await expect(
		readColumns(db, { id: viewer.id }, reference),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
});
