import { getAuth } from "../auth/auth.server";
import type { createAuth } from "../auth/create-auth.server";
import { applicationSession } from "../auth/session.server";
import { getDatabase } from "../db/client.server";
import type { Actor } from "../organizations/access.server";
import type {
	OperationResult,
	ProjectReference,
} from "../organizations/contracts";
import { OperationError } from "../organizations/errors";
import type {
	CreateExecutionInput,
	ExecutionReference,
	TelemetryInput,
} from "./contracts";
import * as operations from "./executions.server";

export function createExecutionRequests(
	database: ReturnType<typeof getDatabase>,
	auth: ReturnType<typeof createAuth>,
) {
	async function request<T>(
		headers: Headers,
		operation: (actor: Actor) => Promise<T>,
	): Promise<OperationResult<T>> {
		try {
			return {
				data: await operation((await applicationSession(auth, headers)).user),
				error: null,
			};
		} catch (error) {
			if (error instanceof OperationError)
				return {
					data: null,
					error: {
						code: error.code,
						message: error.message,
						reason: error.reason,
					},
				};
			throw new Error("The execution operation could not complete");
		}
	}
	return {
		listExecutions: (
			headers: Headers,
			input: ProjectReference & { beforeId?: string },
		) =>
			request(headers, (actor) =>
				operations.listExecutions(database, actor, input),
			),
		listExecutionSources: (headers: Headers, input: ProjectReference) =>
			request(headers, (actor) =>
				operations.listExecutionSources(database, actor, input),
			),
		getExecution: (headers: Headers, input: ExecutionReference) =>
			request(headers, (actor) =>
				operations.getExecution(database, actor, input),
			),
		createExecution: (headers: Headers, input: CreateExecutionInput) =>
			request(headers, (actor) =>
				operations.createExecution(database, actor, input),
			),
		updateExecution: (
			headers: Headers,
			input: ExecutionReference & { name: string },
		) =>
			request(headers, (actor) =>
				operations.updateExecution(database, actor, input),
			),
		queryExecutionTelemetry: (
			headers: Headers,
			input: TelemetryInput,
			signal?: AbortSignal,
		) =>
			request(headers, (actor) =>
				operations.queryExecutionTelemetry(database, actor, input, signal),
			),
	};
}
export function getExecutionRequests() {
	return createExecutionRequests(getDatabase(), getAuth());
}
