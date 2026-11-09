import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { getDatabase } from "../db/client.server";
import { createReceipt } from "../db/create-receipts-schema";
import { OperationError } from "../organizations/errors";

type Database = ReturnType<typeof getDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type CreateScope = { organizationId: string } & (
	| { operation: "create-project"; projectId: null }
	| { operation: "create-execution"; projectId: string }
);

export function createInputHash(
	scope: CreateScope,
	values: readonly (string | null)[],
) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				scope.operation,
				scope.organizationId,
				scope.projectId,
				...values,
			]),
		)
		.digest("hex");
}

export function createOnce<Access, Result>(
	database: Database,
	input: {
		actorId: string;
		requestId: string;
		scope: CreateScope;
		values: readonly (string | null)[];
		resourceId: string;
		authorize: (tx: Transaction) => Promise<Access>;
		create: (
			tx: Transaction,
			resourceId: string,
			access: Access,
		) => Promise<void>;
		read: (tx: Transaction, resourceId: string) => Promise<Result>;
	},
) {
	return database.transaction(
		async (tx) => {
			await input.authorize(tx);
			const expected = {
				actorId: input.actorId,
				requestId: input.requestId,
				...input.scope,
				inputHash: createInputHash(input.scope, input.values),
				resourceId: input.resourceId,
			};
			const [inserted] = await tx
				.insert(createReceipt)
				.values(expected)
				.onConflictDoNothing({
					target: [createReceipt.actorId, createReceipt.requestId],
				})
				.returning();
			// A waiter can win after rollback, so both branches must recheck authority.
			const access = await input.authorize(tx);
			// A separate statement sees the committed winner after a uniqueness wait.
			const receipt =
				inserted ??
				(
					await tx
						.select()
						.from(createReceipt)
						.where(
							and(
								eq(createReceipt.actorId, input.actorId),
								eq(createReceipt.requestId, input.requestId),
							),
						)
				)[0];
			if (!receipt)
				throw new OperationError("NOT_FOUND", "Create receipt unavailable");
			if (
				receipt.operation !== expected.operation ||
				receipt.organizationId !== expected.organizationId ||
				receipt.projectId !== expected.projectId ||
				receipt.inputHash !== expected.inputHash
			)
				throw new OperationError(
					"CONFLICT",
					"This request ID belongs to a different submission",
					"REQUEST_ID_REUSED",
				);
			if (inserted) await input.create(tx, receipt.resourceId, access);
			return input.read(tx, receipt.resourceId);
		},
		{ isolationLevel: "read committed" },
	);
}
