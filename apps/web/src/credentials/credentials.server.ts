import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import { pick } from "es-toolkit";
import type { getDatabase } from "../db/client.server";
import {
	collectorCredential,
	collectorResourceGrant,
	collectorRootGrant,
} from "../db/schema";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import { OperationError } from "../organizations/errors";
import { parseProjectReference } from "../organizations/validation";
import type {
	CollectorCredentialReference,
	CollectorCredentialSummary,
	CreateCollectorCredentialInput,
	RevealedCollectorCredential,
} from "./contracts";
import {
	parseCollectorCredentialReference,
	parseCreateCollectorCredentialInput,
} from "./validation";

type Database = ReturnType<typeof getDatabase>;

// Never select or return the token hash in credential management operations.
const summaryColumns = pick(getTableColumns(collectorCredential), [
	"id",
	"organizationId",
	"projectId",
	"name",
	"sourceId",
	"rootId",
	"rootKind",
	"maximumSubmissionAge",
	"allowedClockSkew",
	"createdAt",
	"rotatedAt",
	"expiresAt",
	"revokedAt",
]) satisfies Pick<typeof collectorCredential, keyof CollectorCredentialSummary>;

function secret(id: string) {
	const token = `recount_${id}_${randomBytes(32).toString("base64url")}`;
	return {
		token,
		tokenSha256: createHash("sha256").update(token, "ascii").digest("hex"),
	};
}

function scope(input: CollectorCredentialReference) {
	return and(
		eq(collectorCredential.id, input.credentialId),
		eq(collectorCredential.projectId, input.projectId),
		eq(collectorCredential.organizationId, input.organizationId),
	);
}

export async function listCollectorCredentials(
	database: Database,
	actor: Actor,
	reference: ProjectReference,
) {
	const input = parseProjectReference(reference);
	await requireProject(database, actor, input, "admin");
	const rows = await database
		.select(summaryColumns)
		.from(collectorCredential)
		.where(
			and(
				eq(collectorCredential.projectId, input.projectId),
				eq(collectorCredential.organizationId, input.organizationId),
			),
		)
		.orderBy(asc(collectorCredential.createdAt), asc(collectorCredential.id));
	return rows;
}
export async function createCollectorCredential(
	database: Database,
	actor: Actor,
	value: CreateCollectorCredentialInput,
): Promise<RevealedCollectorCredential> {
	const input = parseCreateCollectorCredentialInput(value);
	await requireProject(database, actor, input, "admin");
	const id = randomUUID();
	const { token, tokenSha256 } = secret(id);
	const expiresAt = sql<Date | null>`${input.expiresAt}::timestamptz`;
	return database.transaction(async (transaction) => {
		const [created] = await transaction
			.insert(collectorCredential)
			.select((query) =>
				query
					.select({
						id: sql<string>`${id}::uuid`.as("id"),
						organizationId: sql<string>`${input.organizationId}::text`.as(
							"organization_id",
						),
						projectId: sql<string>`${input.projectId}::uuid`.as("project_id"),
						sourceId: sql<string>`${input.sourceId}::text`.as("source_id"),
						name: sql<string>`${input.name}::text`.as("name"),
						tokenSha256: sql<string>`${tokenSha256}::text`.as("token_sha256"),
						rootId: sql<string>`${input.rootId}::text`.as("root_id"),
						rootKind: sql<number>`${input.rootKind}::integer`.as("root_kind"),
						maximumSubmissionAge:
							sql<number>`${input.maximumSubmissionAge}::bigint`.as(
								"maximum_submission_age",
							),
						allowedClockSkew: sql<number>`${input.allowedClockSkew}::bigint`.as(
							"allowed_clock_skew",
						),
						createdAt: sql<Date>`creation.now`.as("created_at"),
						rotatedAt: sql<Date | null>`NULL::timestamptz`.as("rotated_at"),
						expiresAt: expiresAt.as("expires_at"),
						revokedAt: sql<Date | null>`NULL::timestamptz`.as("revoked_at"),
					})
					.from(sql`(SELECT statement_timestamp() AS now) AS creation`)
					.where(sql`${expiresAt} IS NULL OR ${expiresAt} > creation.now`),
			)
			.returning(summaryColumns);
		if (!created)
			throw new OperationError(
				"INVALID_INPUT",
				"Expiration must be in the future",
				"INVALID_EXPIRY",
			);
		const tenant = {
			credentialId: id,
			projectId: input.projectId,
			organizationId: input.organizationId,
		};
		await transaction.insert(collectorRootGrant).values([
			{
				...tenant,
				resourceId: input.rootId,
				resourceKind: input.rootKind ?? 1,
				adapter: input.adapter ?? "standard",
				allowedLocalKinds: input.allowedLocalKinds ?? [],
			},
			...(input.additionalRoots ?? []).map((grant) => ({
				...tenant,
				...grant,
			})),
		]);
		if (input.resources?.length)
			await transaction
				.insert(collectorResourceGrant)
				.values(input.resources.map((grant) => ({ ...tenant, ...grant })));
		return { credential: created, token };
	});
}
export async function rotateCollectorCredential(
	database: Database,
	actor: Actor,
	value: CollectorCredentialReference,
): Promise<RevealedCollectorCredential> {
	const input = parseCollectorCredentialReference(value);
	await requireProject(database, actor, input, "admin");
	const { token, tokenSha256 } = secret(input.credentialId.toLowerCase());
	const [updated] = await database
		.update(collectorCredential)
		.set({
			tokenSha256,
			rotatedAt: sql`statement_timestamp()`,
		})
		.where(
			and(
				scope(input),
				isNull(collectorCredential.revokedAt),
				or(
					isNull(collectorCredential.expiresAt),
					sql`${collectorCredential.expiresAt} > statement_timestamp()`,
				),
			),
		)
		.returning(summaryColumns);
	if (!updated)
		throw new OperationError(
			"NOT_FOUND",
			"Active collector credential not found",
		);
	return { credential: updated, token };
}
export async function revokeCollectorCredential(
	database: Database,
	actor: Actor,
	value: CollectorCredentialReference,
) {
	const input = parseCollectorCredentialReference(value);
	await requireProject(database, actor, input, "admin");
	const [updated] = await database
		.update(collectorCredential)
		.set({
			revokedAt: sql`coalesce(${collectorCredential.revokedAt}, statement_timestamp())`,
		})
		.where(scope(input))
		.returning(summaryColumns);
	if (!updated)
		throw new OperationError("NOT_FOUND", "Collector credential not found");
	return updated;
}
