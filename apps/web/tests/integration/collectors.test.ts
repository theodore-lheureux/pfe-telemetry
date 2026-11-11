import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
	randomUUID,
	sign,
	verify,
} from "node:crypto";
import { eq } from "drizzle-orm";
import { actorService } from "../../src/auth/actor.server";
import { createAuth } from "../../src/auth/create-auth.server";
import * as collectors from "../../src/collectors/collectors.server";
import {
	publicKeySet,
	tokenRequestMessage,
} from "../../src/collectors/tokens.server";
import { collectorNode, member } from "../../src/db/schema";
import { OperationError } from "../../src/lib/operation-error";
import type { OperationResult } from "../../src/lib/operation-result";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";
import { trustedActor } from "../auth-actors";
import { createTestDatabase } from "../database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
let requests: ReturnType<typeof actorService>;
const origin = "http://localhost:3001";
const codes = new Map<string, string>();
let count = 0;

function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}

async function actor() {
	return trustedActor(
		auth,
		`collectors-${++count}@example.invalid`,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
}

function machine() {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const { x } = publicKey.export({ format: "jwk" });
	return {
		publicKey: x as string,
		signToken(nodeId: string, timestamp = Math.floor(Date.now() / 1000)) {
			return {
				nodeId,
				timestamp,
				signature: sign(
					null,
					tokenRequestMessage(nodeId, timestamp),
					privateKey,
				).toString("base64url"),
			};
		},
	};
}

function claims(token: string) {
	const [header, payload, signature] = token.split(".");
	const [key] = publicKeySet().keys;
	const valid = verify(
		null,
		Buffer.from(`${header}.${payload}`),
		createPublicKey({ key, format: "jwk" }),
		Buffer.from(signature, "base64url"),
	);
	expect(valid).toBe(true);
	expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject(
		{
			alg: "EdDSA",
			kid: key.kid,
		},
	);
	return JSON.parse(Buffer.from(payload, "base64url").toString());
}

async function rejection(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof OperationError) return error.code;
		throw error;
	}
	throw new Error("Expected the operation to be rejected");
}

beforeAll(async () => {
	process.env.RECOUNT_COLLECTOR_SIGNING_KEY =
		randomBytes(32).toString("base64url");
	database = await createTestDatabase("collectors");
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret: `collectors-test-${randomUUID()}`,
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
	requests = actorService(auth);
});

afterAll(async () => {
	await auth?.emailDelivery.close();
	await database?.close();
});

async function scenario() {
	const owner = await actor();
	const organization = data(
		await requests(owner.headers, () =>
			organizationDomain.createOrganization(auth, owner.headers, {
				name: "Fleet",
				slug: `fleet-${randomUUID()}`,
			}),
		),
	);
	const project = data(
		await requests(owner.headers, (actor) =>
			projectDomain.createProject(database.db, actor, {
				requestId: randomUUID(),
				organizationId: organization.id,
				name: "Fleet project",
			}),
		),
	);
	const reference = { organizationId: organization.id, projectId: project.id };
	const createKey = (values: Record<string, unknown> = {}) =>
		requests(owner.headers, (actor) =>
			collectors.createEnrollmentKey(database.db, actor, {
				...reference,
				name: "prod-linux",
				...values,
			}),
		);
	return { owner, organization, project, reference, createKey };
}

test("only project administrators manage enrollment keys and nodes", async () => {
	const { organization, reference } = await scenario();
	const outsider = await actor();
	await database.db.insert(member).values({
		id: randomUUID(),
		organizationId: organization.id,
		userId: outsider.id,
		role: "member",
		createdAt: new Date(),
	});
	expect(
		(
			await requests(outsider.headers, (actor) =>
				collectors.listNodes(database.db, actor, reference),
			)
		).error?.code,
	).toMatch(/FORBIDDEN|NOT_FOUND/);
	expect(
		(
			await requests(outsider.headers, (actor) =>
				collectors.createEnrollmentKey(database.db, actor, {
					...reference,
					name: "denied",
				}),
			)
		).error?.code,
	).toMatch(/FORBIDDEN|NOT_FOUND/);
});

test("enrollment issues a signed token and reenrollment keeps the node", async () => {
	const { owner, reference, createKey } = await scenario();
	const created = data(await createKey({ labels: ["prod", "linux"] }));
	expect(created.key).toMatch(/^recount_enroll_/);
	expect(created.enrollmentKey).not.toHaveProperty("keySha256");
	expect(created.enrollmentKey.allowedLocalKinds).toEqual([4, 6]);

	const first = machine();
	const enrolled = await collectors.enrollNode(database.db, {
		enrollmentKey: created.key,
		machineId: "machine-a",
		hostname: "web-01",
		publicKey: first.publicKey,
		collectorVersion: "1.2.3",
	});
	expect(claims(enrolled.token)).toMatchObject({
		sub: enrolled.nodeId,
		org: reference.organizationId,
		project: reference.projectId,
		root: "machine-a",
		rootKind: 1,
		adapter: "linux",
		localKinds: [4, 6],
		maxAge: 3600,
		skew: 60,
		aud: "recount-ingestion",
	});
	expect(enrolled.expiresAt.getTime() - Date.now()).toBeGreaterThan(3500_000);

	const replacement = machine();
	const again = await collectors.enrollNode(database.db, {
		enrollmentKey: created.key,
		machineId: "machine-a",
		hostname: "web-01-renamed",
		publicKey: replacement.publicKey,
	});
	expect(again.nodeId).toBe(enrolled.nodeId);
	expect(
		await rejection(
			collectors.issueNodeToken(database.db, first.signToken(enrolled.nodeId)),
		),
	).toBe("FORBIDDEN");
	const refreshed = await collectors.issueNodeToken(
		database.db,
		replacement.signToken(enrolled.nodeId),
	);
	expect(claims(refreshed.token).sub).toBe(enrolled.nodeId);

	const page = data(
		await requests(owner.headers, (actor) =>
			collectors.listNodes(database.db, actor, reference),
		),
	);
	expect(page.total).toBe(1);
	expect(page.nodes[0]).toMatchObject({
		id: enrolled.nodeId,
		hostname: "web-01-renamed",
		labels: ["prod", "linux"],
		enrollmentKeyName: "prod-linux",
	});
	expect(page.nodes[0]).not.toHaveProperty("publicKey");
	const keys = data(
		await requests(owner.headers, (actor) =>
			collectors.listEnrollmentKeys(database.db, actor, reference),
		),
	);
	expect(keys).toHaveLength(1);
	expect(keys[0].activeNodes).toBe(1);
	expect(keys[0]).not.toHaveProperty("keySha256");
});

test("another enrollment key cannot replace a node or acquire its renewal policy", async () => {
	const { owner, reference, createKey } = await scenario();
	const originalKey = data(await createKey({ name: "linux-policy" }));
	const restrictedKey = data(
		await createKey({
			name: "restricted-policy",
			adapter: "standard",
			allowedLocalKinds: [],
			maximumSubmissionAge: 60,
			allowedClockSkew: 0,
		}),
	);
	const original = machine(),
		replacement = machine();
	const enrolled = await collectors.enrollNode(database.db, {
		enrollmentKey: originalKey.key,
		machineId: "same-machine",
		hostname: "original",
		publicKey: original.publicKey,
	});
	expect(
		await rejection(
			collectors.enrollNode(database.db, {
				enrollmentKey: restrictedKey.key,
				machineId: "same-machine",
				hostname: "replacement",
				publicKey: replacement.publicKey,
			}),
		),
	).toBe("FORBIDDEN");
	expect(
		await rejection(
			collectors.issueNodeToken(
				database.db,
				replacement.signToken(enrolled.nodeId),
			),
		),
	).toBe("FORBIDDEN");
	const renewed = await collectors.issueNodeToken(
		database.db,
		original.signToken(enrolled.nodeId),
	);
	expect(claims(renewed.token)).toMatchObject({
		sub: enrolled.nodeId,
		adapter: "linux",
		localKinds: [4, 6],
		maxAge: 3600,
		skew: 60,
	});
	const page = data(
		await requests(owner.headers, (actor) =>
			collectors.listNodes(database.db, actor, reference),
		),
	);
	expect(page.total).toBe(1);
	expect(page.nodes[0]).toMatchObject({
		id: enrolled.nodeId,
		hostname: "original",
		enrollmentKeyId: originalKey.enrollmentKey.id,
	});
});

test("invalid, revoked and exhausted keys cannot enroll new machines", async () => {
	const { owner, reference, createKey } = await scenario();
	const limited = data(await createKey({ name: "one-off", maxNodes: 1 }));
	const node = machine();
	await collectors.enrollNode(database.db, {
		enrollmentKey: limited.key,
		machineId: "only",
		hostname: "only",
		publicKey: node.publicKey,
	});
	expect(
		await rejection(
			collectors.enrollNode(database.db, {
				enrollmentKey: limited.key,
				machineId: "second",
				hostname: "second",
				publicKey: machine().publicKey,
			}),
		),
	).toBe("CAPACITY");
	const wrong = limited.key.replace(/.$/, (last) => (last === "A" ? "B" : "A"));
	expect(
		await rejection(
			collectors.enrollNode(database.db, {
				enrollmentKey: wrong,
				machineId: "x",
				hostname: "x",
				publicKey: machine().publicKey,
			}),
		),
	).toBe("FORBIDDEN");
	data(
		await requests(owner.headers, (actor) =>
			collectors.revokeEnrollmentKey(database.db, actor, {
				...reference,
				enrollmentKeyId: limited.enrollmentKey.id,
			}),
		),
	);
	expect(
		await rejection(
			collectors.enrollNode(database.db, {
				enrollmentKey: limited.key,
				machineId: "only",
				hostname: "only",
				publicKey: node.publicKey,
			}),
		),
	).toBe("FORBIDDEN");
	expect(
		(await createKey({ expiresAt: new Date(Date.now() - 1000).toISOString() }))
			.error?.code,
	).toBe("INVALID_INPUT");
});

test("token requests require a fresh signature from an active node", async () => {
	const { owner, reference, createKey } = await scenario();
	const created = data(await createKey());
	const node = machine();
	const { nodeId } = await collectors.enrollNode(database.db, {
		enrollmentKey: created.key,
		machineId: "token-node",
		hostname: "token-node",
		publicKey: node.publicKey,
	});
	const stale = node.signToken(nodeId, Math.floor(Date.now() / 1000) - 600);
	expect(await rejection(collectors.issueNodeToken(database.db, stale))).toBe(
		"FORBIDDEN",
	);
	const forged = { ...node.signToken(nodeId), signature: "A".repeat(86) };
	expect(await rejection(collectors.issueNodeToken(database.db, forged))).toBe(
		"FORBIDDEN",
	);
	// Revoking the enrollment key does not affect nodes it already enrolled.
	data(
		await requests(owner.headers, (actor) =>
			collectors.revokeEnrollmentKey(database.db, actor, {
				...reference,
				enrollmentKeyId: created.enrollmentKey.id,
			}),
		),
	);
	await collectors.issueNodeToken(database.db, node.signToken(nodeId));
	data(
		await requests(owner.headers, (actor) =>
			collectors.revokeNodes(database.db, actor, {
				...reference,
				nodeIds: [nodeId],
			}),
		),
	);
	expect(
		await rejection(
			collectors.issueNodeToken(database.db, node.signToken(nodeId)),
		),
	).toBe("FORBIDDEN");
});

test("deleted nodes stay revoked, leave the list and can enroll again as new nodes", async () => {
	const { owner, reference, createKey } = await scenario();
	const created = data(await createKey());
	const enroll = (machineId: string, hostname = machineId) =>
		collectors.enrollNode(database.db, {
			enrollmentKey: created.key,
			machineId,
			hostname,
			publicKey: machine().publicKey,
		});
	const gone = await enroll("gone", "db-01");
	await enroll("kept", "web-01");
	data(
		await requests(owner.headers, (actor) =>
			collectors.deleteNodes(database.db, actor, {
				...reference,
				nodeIds: [gone.nodeId],
			}),
		),
	);
	const [row] = await database.db
		.select({
			revokedAt: collectorNode.revokedAt,
			deletedAt: collectorNode.deletedAt,
		})
		.from(collectorNode)
		.where(eq(collectorNode.id, gone.nodeId));
	expect(row.revokedAt).toBeInstanceOf(Date);
	expect(row.deletedAt).toBeInstanceOf(Date);
	const list = (values: Record<string, unknown>) =>
		requests(owner.headers, (actor) =>
			collectors.listNodes(database.db, actor, { ...reference, ...values }),
		);
	expect(
		data(await list({ status: "all" })).nodes.map((node) => node.hostname),
	).toEqual(["web-01"]);
	expect(data(await list({ query: "web" })).total).toBe(1);
	expect(data(await list({ query: "db" })).total).toBe(0);
	const returned = await enroll("gone", "db-01");
	expect(returned.nodeId).not.toBe(gone.nodeId);
});
