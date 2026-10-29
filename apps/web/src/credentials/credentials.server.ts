import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import { pick } from "es-toolkit";
import type { createAuth } from "../auth/create-auth.server";
import type { getDatabase } from "../db/client.server";
import { collectorCredential } from "../db/schema";
import type {
	OperationResult,
	ProjectReference,
} from "../organizations/contracts";
import { OperationError } from "../organizations/errors";
import { createOrganizationRequests } from "../organizations/request.server";
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
	"hosts",
	"requireHostId",
	"maximumSubmissionAge",
	"allowedClockSkew",
	"createdAt",
	"rotatedAt",
	"expiresAt",
	"revokedAt",
]) satisfies Pick<typeof collectorCredential, keyof CollectorCredentialSummary>;

function secret(id: string) {
	const token = `pfe_${id}_${randomBytes(32).toString("base64url")}`;
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

export function createCollectorCredentialRequests(
	database: Database,
	auth: ReturnType<typeof createAuth>,
) {
	const access = createOrganizationRequests(database, auth);
	async function request<T>(
		headers: Headers,
		reference: ProjectReference,
		operation: () => Promise<T>,
	): Promise<OperationResult<T>> {
		try {
			await access.requireProjectAccess(headers, reference, "admin");
			return { data: await operation(), error: null };
		} catch (error) {
			if (!(error instanceof OperationError)) throw error;
			return {
				data: null,
				error: {
					code: error.code,
					message: error.message,
					reason: error.reason,
				},
			};
		}
	}

	return {
		listCollectorCredentials(headers: Headers, reference: ProjectReference) {
			const input = parseProjectReference(reference);
			return request(headers, input, async () => {
				const rows = await database
					.select(summaryColumns)
					.from(collectorCredential)
					.where(
						and(
							eq(collectorCredential.projectId, input.projectId),
							eq(collectorCredential.organizationId, input.organizationId),
						),
					)
					.orderBy(
						asc(collectorCredential.createdAt),
						asc(collectorCredential.id),
					);
				return rows;
			});
		},
		createCollectorCredential(
			headers: Headers,
			value: CreateCollectorCredentialInput,
		) {
			const input = parseCreateCollectorCredentialInput(value);
			return request(
				headers,
				input,
				async (): Promise<RevealedCollectorCredential> => {
					const id = randomUUID();
					const { token, tokenSha256 } = secret(id);
					const expiresAt = sql<Date | null>`${input.expiresAt}::timestamptz`;
					const [created] = await database
						.insert(collectorCredential)
						.select((query) =>
							query
								.select({
									id: sql<string>`${id}::uuid`.as("id"),
									organizationId: sql<string>`${input.organizationId}::text`.as(
										"organization_id",
									),
									projectId: sql<string>`${input.projectId}::uuid`.as(
										"project_id",
									),
									sourceId: sql<string>`${input.sourceId}::text`.as(
										"source_id",
									),
									name: sql<string>`${input.name}::text`.as("name"),
									tokenSha256: sql<string>`${tokenSha256}::text`.as(
										"token_sha256",
									),
									hosts: sql<
										string[]
									>`${sql.param(input.hosts, collectorCredential.hosts)}::text[]`.as(
										"hosts",
									),
									requireHostId:
										sql<boolean>`${input.requireHostId}::boolean`.as(
											"require_host_id",
										),
									maximumSubmissionAge:
										sql<number>`${input.maximumSubmissionAge}::integer`.as(
											"maximum_submission_age",
										),
									allowedClockSkew:
										sql<number>`${input.allowedClockSkew}::integer`.as(
											"allowed_clock_skew",
										),
									createdAt: sql<Date>`creation.now`.as("created_at"),
									rotatedAt: sql<Date | null>`NULL::timestamptz`.as(
										"rotated_at",
									),
									expiresAt: expiresAt.as("expires_at"),
									revokedAt: sql<Date | null>`NULL::timestamptz`.as(
										"revoked_at",
									),
								})
								.from(sql`(SELECT statement_timestamp() AS now) AS creation`)
								.where(
									sql`${expiresAt} IS NULL OR ${expiresAt} > creation.now`,
								),
						)
						.returning(summaryColumns);
					if (!created)
						throw new OperationError(
							"INVALID_INPUT",
							"Expiration must be in the future",
							"INVALID_EXPIRY",
						);
					return { credential: created, token };
				},
			);
		},
		rotateCollectorCredential(
			headers: Headers,
			value: CollectorCredentialReference,
		) {
			const input = parseCollectorCredentialReference(value);
			return request(
				headers,
				input,
				async (): Promise<RevealedCollectorCredential> => {
					const { token, tokenSha256 } = secret(
						input.credentialId.toLowerCase(),
					);
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
				},
			);
		},
		revokeCollectorCredential(
			headers: Headers,
			value: CollectorCredentialReference,
		) {
			const input = parseCollectorCredentialReference(value);
			return request(headers, input, async () => {
				const [updated] = await database
					.update(collectorCredential)
					.set({
						revokedAt: sql`coalesce(${collectorCredential.revokedAt}, statement_timestamp())`,
					})
					.where(scope(input))
					.returning(summaryColumns);
				if (!updated)
					throw new OperationError(
						"NOT_FOUND",
						"Collector credential not found",
					);
				return updated;
			});
		},
	};
}
