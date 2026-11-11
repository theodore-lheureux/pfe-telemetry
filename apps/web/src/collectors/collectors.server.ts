import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import {
	and,
	asc,
	count,
	eq,
	getTableColumns,
	ilike,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import { pick } from "es-toolkit";
import type { getDatabase } from "../db/client.server";
import { collectorNode, enrollmentKey } from "../db/schema";
import { OperationError } from "../lib/operation-error";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import { parseProjectReference } from "../organizations/validation";
import {
	type CreateEnrollmentKeyInput,
	type EnrollmentKeyReference,
	type EnrollmentKeySummary,
	type EnrollNodeInput,
	type IssuedNodeToken,
	type ListNodesInput,
	NODES_PER_PAGE,
	type NodePage,
	type NodesReference,
	type NodeTokenInput,
	type RevealedEnrollmentKey,
} from "./contracts";
import {
	signAccessToken,
	TOKEN_REQUEST_WINDOW_SECONDS,
	tokenRequestMessage,
	verifyNodeSignature,
} from "./tokens.server";
import {
	ENROLLMENT_KEY,
	parseCreateEnrollmentKeyInput,
	parseEnrollmentKeyReference,
	parseEnrollNodeInput,
	parseListNodesInput,
	parseNodesReference,
	parseNodeTokenInput,
} from "./validation";

type Database = ReturnType<typeof getDatabase>;

// Never select or return the key digest from management operations.
const keyColumns = pick(getTableColumns(enrollmentKey), [
	"id",
	"organizationId",
	"projectId",
	"name",
	"adapter",
	"allowedLocalKinds",
	"maximumSubmissionAge",
	"allowedClockSkew",
	"maxNodes",
	"labels",
	"createdAt",
	"expiresAt",
	"revokedAt",
]);

const nodeColumns = {
	id: collectorNode.id,
	enrollmentKeyId: collectorNode.enrollmentKeyId,
	enrollmentKeyName: enrollmentKey.name,
	machineId: collectorNode.machineId,
	hostname: collectorNode.hostname,
	labels: collectorNode.labels,
	collectorVersion: collectorNode.collectorVersion,
	enrolledAt: collectorNode.enrolledAt,
	lastSeenAt: collectorNode.lastSeenAt,
	revokedAt: collectorNode.revokedAt,
};

function digest(value: string) {
	return createHash("sha256").update(value, "ascii").digest("hex");
}

function tenant(
	table: typeof enrollmentKey | typeof collectorNode,
	input: ProjectReference,
) {
	return and(
		eq(table.projectId, input.projectId),
		eq(table.organizationId, input.organizationId),
	);
}

// Columns are qualified by hand: Drizzle leaves them bare in a single-table select, which
// would bind the outer key ID to the subquery's own table.
const activeNodeCount = sql<number>`(
	SELECT count(*)::integer FROM "ingestion"."collector_node" AS node
	WHERE node."enrollment_key_id" = "ingestion"."enrollment_key"."id"
	AND node."revoked_at" IS NULL
)`;

export async function listEnrollmentKeys(
	database: Database,
	actor: Actor,
	reference: ProjectReference,
): Promise<EnrollmentKeySummary[]> {
	const input = parseProjectReference(reference);
	await requireProject(database, actor, input, "admin");
	const rows = await database
		.select({ ...keyColumns, activeNodes: activeNodeCount })
		.from(enrollmentKey)
		.where(tenant(enrollmentKey, input))
		.orderBy(asc(enrollmentKey.createdAt), asc(enrollmentKey.id));
	return rows.map((row) => ({
		...row,
		adapter: row.adapter as EnrollmentKeySummary["adapter"],
	}));
}

export async function createEnrollmentKey(
	database: Database,
	actor: Actor,
	value: CreateEnrollmentKeyInput,
): Promise<RevealedEnrollmentKey> {
	const input = parseCreateEnrollmentKeyInput(value);
	await requireProject(database, actor, input, "admin");
	const id = randomUUID();
	const key = `recount_enroll_${id}_${randomBytes(32).toString("base64url")}`;
	const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
	if (expiresAt && expiresAt.getTime() <= Date.now())
		throw new OperationError(
			"INVALID_INPUT",
			"Expiration must be in the future",
			"INVALID_EXPIRY",
		);
	const [created] = await database
		.insert(enrollmentKey)
		.values({
			id,
			organizationId: input.organizationId,
			projectId: input.projectId,
			name: input.name,
			keySha256: digest(key),
			adapter: input.adapter,
			allowedLocalKinds: input.allowedLocalKinds,
			maximumSubmissionAge: input.maximumSubmissionAge,
			allowedClockSkew: input.allowedClockSkew,
			maxNodes: input.maxNodes,
			labels: input.labels,
			expiresAt,
		})
		.returning(keyColumns);
	return {
		enrollmentKey: {
			...created,
			adapter: created.adapter as EnrollmentKeySummary["adapter"],
			activeNodes: 0,
		},
		key,
	};
}

export async function revokeEnrollmentKey(
	database: Database,
	actor: Actor,
	value: EnrollmentKeyReference,
) {
	const input = parseEnrollmentKeyReference(value);
	await requireProject(database, actor, input, "admin");
	const [updated] = await database
		.update(enrollmentKey)
		.set({
			revokedAt: sql`coalesce(${enrollmentKey.revokedAt}, statement_timestamp())`,
		})
		.where(
			and(
				eq(enrollmentKey.id, input.enrollmentKeyId),
				tenant(enrollmentKey, input),
			),
		)
		.returning({ id: enrollmentKey.id });
	if (!updated)
		throw new OperationError("NOT_FOUND", "Enrollment key not found");
	return updated;
}

export async function listNodes(
	database: Database,
	actor: Actor,
	value: ListNodesInput,
): Promise<NodePage> {
	const input = parseListNodesInput(value);
	await requireProject(database, actor, input, "admin");
	const pattern = `%${input.query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
	const filter = and(
		tenant(collectorNode, input),
		isNull(collectorNode.deletedAt),
		input.status === "active"
			? isNull(collectorNode.revokedAt)
			: input.status === "revoked"
				? isNotNull(collectorNode.revokedAt)
				: undefined,
		input.query
			? or(
					ilike(collectorNode.hostname, pattern),
					ilike(collectorNode.machineId, pattern),
					sql`array_to_string(${collectorNode.labels}, ' ') ILIKE ${pattern}`,
				)
			: undefined,
	);
	const [{ total }] = await database
		.select({ total: count() })
		.from(collectorNode)
		.where(filter);
	const nodes = await database
		.select(nodeColumns)
		.from(collectorNode)
		.innerJoin(
			enrollmentKey,
			eq(enrollmentKey.id, collectorNode.enrollmentKeyId),
		)
		.where(filter)
		.orderBy(asc(collectorNode.hostname), asc(collectorNode.id))
		.limit(NODES_PER_PAGE)
		.offset((input.page - 1) * NODES_PER_PAGE);
	return { nodes, total, page: input.page, pageSize: NODES_PER_PAGE };
}

export async function revokeNodes(
	database: Database,
	actor: Actor,
	value: NodesReference,
) {
	const input = parseNodesReference(value);
	await requireProject(database, actor, input, "admin");
	const updated = await database
		.update(collectorNode)
		.set({
			revokedAt: sql`coalesce(${collectorNode.revokedAt}, statement_timestamp())`,
		})
		.where(
			and(
				inArray(collectorNode.id, input.nodeIds),
				tenant(collectorNode, input),
			),
		)
		.returning({ id: collectorNode.id });
	return { revoked: updated.length };
}

/** Hides nodes from management and keeps them revoked; their telemetry is kept. */
export async function deleteNodes(
	database: Database,
	actor: Actor,
	value: NodesReference,
) {
	const input = parseNodesReference(value);
	await requireProject(database, actor, input, "admin");
	const updated = await database
		.update(collectorNode)
		.set({
			revokedAt: sql`coalesce(${collectorNode.revokedAt}, statement_timestamp())`,
			deletedAt: sql`coalesce(${collectorNode.deletedAt}, statement_timestamp())`,
		})
		.where(
			and(
				inArray(collectorNode.id, input.nodeIds),
				tenant(collectorNode, input),
			),
		)
		.returning({ id: collectorNode.id });
	return { deleted: updated.length };
}

function rejected(message = "Enrollment was rejected"): never {
	throw new OperationError("FORBIDDEN", message);
}

function issue(node: {
	id: string;
	organizationId: string;
	projectId: string;
	machineId: string;
	adapter: string;
	allowedLocalKinds: number[];
	maximumSubmissionAge: number;
	allowedClockSkew: number;
}): IssuedNodeToken {
	const { token, expiresAt } = signAccessToken({
		sub: node.id,
		org: node.organizationId,
		project: node.projectId,
		root: node.machineId,
		rootKind: 1,
		adapter: node.adapter as "standard" | "linux",
		localKinds: node.allowedLocalKinds,
		maxAge: node.maximumSubmissionAge,
		skew: node.allowedClockSkew,
	});
	return {
		nodeId: node.id,
		organizationId: node.organizationId,
		projectId: node.projectId,
		token,
		expiresAt,
	};
}

/**
 * Registers a machine with an enrollment key. A machine that is already an active node of
 * the project keeps its node ID and replaces its public key only through its original
 * enrollment key, so reinstalls do not transfer another key's authority.
 */
export async function enrollNode(
	database: Database,
	value: EnrollNodeInput,
): Promise<IssuedNodeToken> {
	const input = parseEnrollNodeInput(value);
	const keyId = ENROLLMENT_KEY.exec(input.enrollmentKey)?.[1];
	if (!keyId) rejected();
	return database.transaction(async (tx) => {
		// Lock the key so concurrent enrollments respect its node limit.
		const [key] = await tx
			.select({
				...keyColumns,
				keySha256: enrollmentKey.keySha256,
				active: sql<boolean>`${enrollmentKey.revokedAt} IS NULL AND (${enrollmentKey.expiresAt} IS NULL OR ${enrollmentKey.expiresAt} > statement_timestamp())`,
			})
			.from(enrollmentKey)
			.where(eq(enrollmentKey.id, keyId))
			.for("update");
		const expected = Buffer.from(key?.keySha256 ?? "0".repeat(64), "hex");
		const actual = Buffer.from(digest(input.enrollmentKey), "hex");
		if (!key || !timingSafeEqual(expected, actual) || !key.active) rejected();
		const [existing] = await tx
			.select({
				id: collectorNode.id,
				enrollmentKeyId: collectorNode.enrollmentKeyId,
			})
			.from(collectorNode)
			.where(
				and(
					eq(collectorNode.projectId, key.projectId),
					eq(collectorNode.machineId, input.machineId),
					isNull(collectorNode.revokedAt),
				),
			);
		if (existing && existing.enrollmentKeyId !== key.id) rejected();
		if (!existing && key.maxNodes !== null) {
			const [{ used }] = await tx
				.select({ used: count() })
				.from(collectorNode)
				.where(
					and(
						eq(collectorNode.enrollmentKeyId, key.id),
						isNull(collectorNode.revokedAt),
					),
				);
			if (used >= key.maxNodes)
				throw new OperationError(
					"CAPACITY",
					"This enrollment key has reached its node limit",
				);
		}
		const [node] = existing
			? await tx
					.update(collectorNode)
					.set({
						publicKey: input.publicKey,
						hostname: input.hostname,
						collectorVersion: input.collectorVersion,
						lastSeenAt: sql`statement_timestamp()`,
					})
					.where(eq(collectorNode.id, existing.id))
					.returning({ id: collectorNode.id })
			: await tx
					.insert(collectorNode)
					.values({
						id: randomUUID(),
						organizationId: key.organizationId,
						projectId: key.projectId,
						enrollmentKeyId: key.id,
						machineId: input.machineId,
						hostname: input.hostname,
						publicKey: input.publicKey,
						labels: key.labels,
						collectorVersion: input.collectorVersion,
					})
					.returning({ id: collectorNode.id });
		return issue({ ...key, id: node.id, machineId: input.machineId });
	});
}

/** Issues a fresh access token to a node that proves possession of its private key. */
export async function issueNodeToken(
	database: Database,
	value: NodeTokenInput,
	now = Math.floor(Date.now() / 1000),
): Promise<IssuedNodeToken> {
	const input = parseNodeTokenInput(value);
	if (Math.abs(now - input.timestamp) > TOKEN_REQUEST_WINDOW_SECONDS)
		rejected("Token request timestamp is outside the allowed window");
	const [node] = await database
		.select({
			id: collectorNode.id,
			organizationId: collectorNode.organizationId,
			projectId: collectorNode.projectId,
			machineId: collectorNode.machineId,
			publicKey: collectorNode.publicKey,
			adapter: enrollmentKey.adapter,
			allowedLocalKinds: enrollmentKey.allowedLocalKinds,
			maximumSubmissionAge: enrollmentKey.maximumSubmissionAge,
			allowedClockSkew: enrollmentKey.allowedClockSkew,
		})
		.from(collectorNode)
		.innerJoin(
			enrollmentKey,
			eq(enrollmentKey.id, collectorNode.enrollmentKeyId),
		)
		.where(
			and(eq(collectorNode.id, input.nodeId), isNull(collectorNode.revokedAt)),
		);
	if (
		!node ||
		!verifyNodeSignature(
			node.publicKey,
			tokenRequestMessage(input.nodeId, input.timestamp),
			input.signature,
		)
	)
		rejected("Token request was rejected");
	await database
		.update(collectorNode)
		.set({ lastSeenAt: sql`statement_timestamp()` })
		.where(eq(collectorNode.id, node.id));
	return issue(node);
}

/** Active nodes offered as execution sources. */
export async function listSourceNodes(
	database: Pick<Database, "select">,
	input: ProjectReference,
) {
	return database
		.select({ nodeId: collectorNode.id, hostname: collectorNode.hostname })
		.from(collectorNode)
		.where(and(tenant(collectorNode, input), isNull(collectorNode.revokedAt)))
		.orderBy(asc(collectorNode.hostname))
		.limit(201);
}
