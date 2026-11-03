import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { applyMigrations } from "../../scripts/migrations";
import { createAuth } from "../../src/auth/create-auth.server";
import { createCollectorCredentialRequests } from "../../src/credentials/credentials.server";
import { createDatabase } from "../../src/db/client.server";
import { execution, member } from "../../src/db/schema";
import { queryExecutionTelemetry } from "../../src/executions/executions.server";
import { createExecutionRequests } from "../../src/executions/request.server";
import { parseCreateExecution } from "../../src/executions/validation";
import type { OperationResult } from "../../src/organizations/contracts";
import { createOrganizationRequests } from "../../src/organizations/request.server";

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) throw new Error("Disposable TEST_DATABASE_URL is required");
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const name = `pfe_executions_${randomUUID().replaceAll("-", "")}`;
let database: ReturnType<typeof createDatabase>;
let auth: ReturnType<typeof createAuth>;
let requests: ReturnType<typeof createExecutionRequests>;
let organizations: ReturnType<typeof createOrganizationRequests>;
const origin = "http://localhost:3001";
const links = new Map<string, string>();
let count = 0;
function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}
async function actor() {
	const email = `execution-${++count}@example.invalid`;
	await auth.handler(
		new Request(`${origin}/api/auth/sign-in/magic-link`, {
			method: "POST",
			headers: {
				origin,
				"content-type": "application/json",
				"x-forwarded-for": `192.0.2.${count}`,
			},
			body: JSON.stringify({ email }),
		}),
	);
	const response = await auth.handler(new Request(links.get(email) as string));
	const headers = new Headers({
		origin,
		cookie: response.headers
			.getSetCookie()
			.map((cookie) => cookie.split(";")[0])
			.join("; "),
	});
	const session = await auth.api.getSession({ headers });
	if (!session) throw new Error("Expected session");
	return { id: session.user.id, headers };
}
beforeAll(async () => {
	await admin.query(`CREATE DATABASE "${name}"`);
	const url = new URL(adminUrl);
	url.pathname = `/${name}`;
	await applyMigrations(url.toString());
	await applyMigrations(url.toString());
	database = createDatabase({ connectionString: url.toString(), max: 4 });
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret: `execution-test-${randomUUID()}`,
			allowSignUp: true,
		},
		database.db,
		{
			sendSignInLink: async (email, link) => {
				links.set(email, link);
			},
			sendOrganizationInvitation: async () => {},
		},
	);
	requests = createExecutionRequests(database.db, auth);
	organizations = createOrganizationRequests(database.db, auth);
});
afterAll(async () => {
	await database?.pool.end();
	await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
	await admin.end();
});

test("independent canonical access, immutable source selection, tenant-qualified cursors and project-wide reads", async () => {
	const owner = await actor();
	const writer = await actor();
	const viewer = await actor();
	const outsider = await actor();
	const organization = data(
		await organizations.createOrganization(owner.headers, {
			name: "Executions",
			slug: `executions-${randomUUID()}`,
		}),
	);
	const project = data(
		await organizations.createProject(owner.headers, {
			organizationId: organization.id,
			name: "Private",
			slug: "private",
		}),
	);
	const other = data(
		await organizations.createProject(owner.headers, {
			organizationId: organization.id,
			name: "Other",
			slug: "other",
		}),
	);
	const reference = { organizationId: organization.id, projectId: project.id };
	for (const entry of [writer, viewer, outsider])
		await database.db.insert(member).values({
			id: randomUUID(),
			organizationId: organization.id,
			userId: entry.id,
			role: "member",
			createdAt: new Date(),
		});
	const memberships = await database.db
		.select()
		.from(member)
		.where(eq(member.organizationId, organization.id));
	for (const [entry, role] of [
		[writer, "member"],
		[viewer, "viewer"],
	] as const)
		data(
			await organizations.setProjectMember(owner.headers, {
				...reference,
				memberId: memberships.find((item) => item.userId === entry.id)
					?.id as string,
				role,
			}),
		);
	const credentials = createCollectorCredentialRequests(database.db, auth);
	const credential = data(
		await credentials.createCollectorCredential(owner.headers, {
			...reference,
			name: "Collector",
			sourceId: "source",
			hosts: ["node1"],
		}),
	);
	const otherCredential = data(
		await credentials.createCollectorCredential(owner.headers, {
			organizationId: organization.id,
			projectId: other.id,
			name: "Other",
			sourceId: "foreign",
			hosts: ["node2"],
		}),
	);
	const input = parseCreateExecution({
		...reference,
		credentialId: credential.credential.id,
		name: "Recorded",
		hostId: "node1",
		startedAt: "2026-11-03T10:00:00Z",
		endedAt: "2026-11-03T11:00:00Z",
	});
	expect(
		(await requests.createExecution(viewer.headers, input)).error?.code,
	).toBe("FORBIDDEN");
	expect(
		(
			await requests.createExecution(writer.headers, {
				...input,
				credentialId: otherCredential.credential.id,
			})
		).error?.code,
	).toBe("NOT_FOUND");
	const entry = data(await requests.createExecution(writer.headers, input));
	const ref = { ...reference, executionId: entry.executionId };
	expect(entry.startedAt).toBeInstanceOf(Date);
	expect(data(await requests.getExecution(viewer.headers, ref)).name).toBe(
		"Recorded",
	);
	expect(
		(await requests.updateExecution(viewer.headers, { ...ref, name: "No" }))
			.error?.code,
	).toBe("FORBIDDEN");
	expect(
		data(
			await requests.updateExecution(owner.headers, {
				...ref,
				name: "Renamed",
			}),
		).sourceId,
	).toBe("source");
	const foreignRef = { ...ref, projectId: other.id };
	for (const headers of [outsider.headers, new Headers()]) {
		const expected =
			headers === outsider.headers ? "NOT_FOUND" : "UNAUTHENTICATED";
		const outcomes = await Promise.all([
			requests.getExecution(headers, ref),
			requests.listExecutions(headers, {
				...reference,
				beforeId: ref.executionId,
			}),
			requests.listExecutionSources(headers, reference),
			requests.queryExecutionTelemetry(headers, {
				...ref,
				from: "2026-11-03T10:10:00Z",
			}),
			requests.createExecution(headers, input),
			requests.updateExecution(headers, { ...ref, name: "No" }),
		]);
		expect(outcomes.every((result) => result.error?.code === expected)).toBe(
			true,
		);
	}
	expect(
		(await requests.getExecution(owner.headers, foreignRef)).error?.code,
	).toBe("NOT_FOUND");
	expect(
		(
			await requests.listExecutions(owner.headers, {
				organizationId: organization.id,
				projectId: other.id,
				beforeId: ref.executionId,
			})
		).error?.code,
	).toBe("NOT_FOUND");
	let scope: unknown;
	await queryExecutionTelemetry(
		database.db,
		viewer,
		{
			...ref,
			from: "2026-11-03T10:10:00Z",
			to: "2026-11-03T10:11:00Z",
			buckets: 60,
		},
		undefined,
		async (value) => {
			scope = value;
			return { from: value.from, to: value.to, bucketMs: 1000, series: [] };
		},
	);
	expect(scope).toEqual({
		projectId: project.id,
		sourceId: "source",
		hostId: "node1",
		from: new Date("2026-11-03T10:10:00Z"),
		to: new Date("2026-11-03T10:11:00Z"),
		buckets: 60,
	});
	await expect(
		queryExecutionTelemetry(database.db, viewer, {
			...ref,
			from: "2026-11-03T09:59:00Z",
		}),
	).rejects.toMatchObject({ code: "INVALID_INPUT" });
	data(
		await credentials.revokeCollectorCredential(owner.headers, {
			...reference,
			credentialId: credential.credential.id,
		}),
	);
	expect(data(await requests.getExecution(viewer.headers, ref)).sourceId).toBe(
		"source",
	);
	const inserted = Array.from({ length: 51 }, () => ({
		id: uuidv7(),
		organizationId: organization.id,
		projectId: project.id,
		name: "Page",
		sourceId: "source",
		startedAt: entry.startedAt,
		endedAt: entry.endedAt,
	}));
	await database.db.insert(execution).values(inserted);
	const first = data(await requests.listExecutions(viewer.headers, reference));
	const second = data(
		await requests.listExecutions(viewer.headers, {
			...reference,
			beforeId: first.nextCursor as string,
		}),
	);
	expect(first.executions).toHaveLength(50);
	expect(second.executions).toHaveLength(2);
	expect(
		new Set(
			[...first.executions, ...second.executions].map(
				(item) => item.executionId,
			),
		).size,
	).toBe(52);
	data(
		await organizations.removeProjectMember(owner.headers, {
			...reference,
			memberId: memberships.find((item) => item.userId === viewer.id)
				?.id as string,
		}),
	);
	expect(
		(await requests.queryExecutionTelemetry(viewer.headers, ref)).error?.code,
	).toBe("NOT_FOUND");
});
