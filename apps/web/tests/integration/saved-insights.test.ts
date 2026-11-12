import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	DEFAULT_DRAFT,
	decodeDraft,
	encodeDraft,
	newSeries,
	sameDraft,
} from "../../src/analytics/insight/draft";
import {
	deleteInsights,
	getInsight,
	listInsights,
	listInsightTags,
	saveInsight,
	updateInsightTags,
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
	database = await createTestDatabase("saved_insights");
	auth = createAuth(
		{
			origin: "http://localhost:3001",
			rpID: "localhost",
			secret: `saved-insights-test-${randomUUID()}`,
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
	series: [
		{
			...newSeries("A"),
			metric: "recount.node.cpu.time",
			calculation: "rate",
			combine: "sum",
		},
	],
});

test("project members save insights that viewers can open but not change", async () => {
	const headers = new Headers({ origin: "http://localhost:3001" });
	const actor = (name: string) =>
		trustedActor(
			auth,
			`insights-${name}-${randomUUID()}@example.invalid`,
			(email) => codes.get(email),
			headers,
		);
	const owner = await actor("owner");
	const writer = await actor("writer");
	const viewer = await actor("viewer");
	const outsider = await actor("outsider");
	const organization = await createOrganization(auth, owner.headers, {
		name: "Insights",
		slug: `insights-${randomUUID()}`,
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
	const db = database.db;
	const insightId = randomUUID();
	const input = { ...reference, insightId, name: "CPU", draft };

	await expect(saveInsight(db, { id: viewer.id }, input)).rejects.toMatchObject(
		{ code: "FORBIDDEN" },
	);
	const saved = await saveInsight(db, { id: writer.id }, input);
	expect(saved).toMatchObject({ id: insightId, name: "CPU" });
	expect(sameDraft(decodeDraft(saved.draft), decodeDraft(draft))).toBe(true);
	// A retried create stores one insight.
	await saveInsight(db, { id: writer.id }, input);
	expect(await listInsights(db, { id: viewer.id }, reference)).toHaveLength(1);

	// Renaming keeps the draft and records who changed it.
	const renamed = await saveInsight(
		db,
		{ id: owner.id },
		{ ...reference, insightId, name: "Fleet CPU" },
	);
	expect(renamed.name).toBe("Fleet CPU");
	expect(sameDraft(decodeDraft(renamed.draft), decodeDraft(draft))).toBe(true);
	expect(renamed.updatedBy).not.toBeNull();
	await expect(
		saveInsight(
			db,
			{ id: owner.id },
			{ ...reference, insightId: randomUUID(), name: "Missing" },
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });

	// The same ID in another project neither overwrites nor reveals this one.
	await expect(
		saveInsight(db, { id: owner.id }, { ...input, projectId: other.id }),
	).rejects.toMatchObject({ code: "CONFLICT" });
	await expect(
		getInsight(
			db,
			{ id: owner.id },
			{ ...reference, projectId: other.id, insightId },
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		listInsights(db, { id: outsider.id }, reference),
	).rejects.toMatchObject({ code: "NOT_FOUND" });

	expect(saved.createdBy?.id).toBe(writer.id);

	// Tags are saved with the insight and changed in bulk within the project.
	const tagged = await saveInsight(
		db,
		{ id: writer.id },
		{ ...reference, insightId, name: "Fleet CPU", tags: ["cpu", "fleet"] },
	);
	expect(tagged.tags).toEqual(["cpu", "fleet"]);
	const change = (mode: "add" | "remove" | "replace", tags: string[]) =>
		updateInsightTags(
			db,
			{ id: writer.id },
			{ ...reference, insightIds: [insightId], mode, tags },
		);
	await change("add", ["FLEET", "linux"]);
	expect(
		(await getInsight(db, { id: viewer.id }, { ...reference, insightId })).tags,
	).toEqual(["cpu", "fleet", "linux"]);
	await change("remove", ["CPU"]);
	await change("replace", ["ops"]);
	expect(await listInsightTags(db, { id: viewer.id }, reference)).toEqual([
		"ops",
	]);
	await expect(
		change(
			"add",
			Array.from({ length: 20 }, (_, index) => `t${index}`),
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	await expect(
		updateInsightTags(
			db,
			{ id: viewer.id },
			{ ...reference, insightIds: [insightId], mode: "add", tags: ["x"] },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		deleteInsights(
			db,
			{ id: viewer.id },
			{ ...reference, insightIds: [insightId] },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	// IDs from another project are ignored; only this project's insight goes.
	expect(
		await deleteInsights(
			db,
			{ id: writer.id },
			{ ...reference, insightIds: [insightId, randomUUID()] },
		),
	).toEqual({ deleted: 1 });
	expect(await listInsights(db, { id: writer.id }, reference)).toEqual([]);
});
