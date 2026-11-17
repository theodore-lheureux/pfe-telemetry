import type { getDatabase } from "../db/client.server";
import { OperationError } from "../lib/operation-error";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import {
	configuredLabGrant,
	isDeveloper,
	semaphoreConfiguration,
} from "./config.server";
import { isLoadAction, type WorkflowInput, workflowFleet } from "./contracts";
import { Semaphore } from "./semaphore.server";

type Database = Parameters<typeof requireProject>[0];
export type DeveloperDependencies = {
	allowed: (id: string) => boolean;
	authorize: (
		database: Database,
		actor: Actor,
		reference: ProjectReference,
		action: "read" | "admin",
	) => Promise<unknown>;
	connector: () => Semaphore | null;
	labGrant: typeof configuredLabGrant;
};
const defaults: DeveloperDependencies = {
	allowed: isDeveloper,
	authorize: requireProject,
	labGrant: configuredLabGrant,
	connector: () => {
		const config = semaphoreConfiguration();
		return config ? new Semaphore(config) : null;
	},
};

export function developerOperations(deps: DeveloperDependencies = defaults) {
	async function authorizeLab(
		database: Database,
		actor: Actor,
		reference: ProjectReference,
		lab: string,
		fleet: "aws-cpu" | "gcp-gpu",
		permission: "read" | "admin",
	) {
		const grant = deps.labGrant(lab);
		if (
			!grant ||
			grant.fleet !== fleet ||
			grant.projectId !== reference.projectId ||
			grant.organizationId !== reference.organizationId
		)
			throw new OperationError("NOT_FOUND", "Lab not found");
		await deps.authorize(database, actor, grant, permission);
	}
	async function authorize(
		database: Database,
		actor: Actor,
		reference: ProjectReference,
		action: "read" | "admin",
	) {
		if (!deps.allowed(actor.id))
			throw new OperationError("FORBIDDEN", "Developer access required");
		await deps.authorize(database, actor, reference, action);
		const connector = deps.connector();
		if (!connector)
			throw new OperationError(
				"UNAVAILABLE",
				"Developer workflows are disabled",
			);
		return connector;
	}
	return {
		async capability(
			database: ReturnType<typeof getDatabase>,
			actor: Actor,
			reference: ProjectReference,
		) {
			if (!deps.allowed(actor.id)) return null;
			await deps.authorize(database, actor, reference, "admin");
			if (!deps.connector()) return null;
			return {
				enabled: true as const,
				gpuEnabled: semaphoreConfiguration()?.gpuEnabled ?? false,
			};
		},
		async recent(
			database: Database,
			actor: Actor,
			reference: ProjectReference,
		) {
			return (await authorize(database, actor, reference, "read")).recent(
				reference.projectId,
				(lab, fleet) =>
					authorizeLab(database, actor, reference, lab, fleet, "read"),
			);
		},
		async run(database: Database, actor: Actor, input: WorkflowInput) {
			const connector = await authorize(database, actor, input, "admin");
			if (isLoadAction(input.action))
				await authorizeLab(
					database,
					actor,
					input,
					input.lab,
					workflowFleet(input.action, input.fleet),
					"admin",
				);
			if (["configure", "move", "destroy"].includes(input.action)) {
				const source = deps.labGrant(input.lab);
				if (!source || source.fleet !== input.fleet)
					throw new OperationError(
						"FORBIDDEN",
						"Existing lab authorization is not configured",
					);
				await deps.authorize(database, actor, source, "admin");
				if (
					input.action !== "move" &&
					(source.projectId !== input.projectId ||
						source.organizationId !== input.organizationId)
				)
					throw new OperationError(
						"FORBIDDEN",
						"Lab belongs to another project",
					);
			}
			return connector.run(input);
		},
		async output(
			database: Database,
			actor: Actor,
			input: ProjectReference & { taskId: number },
		) {
			return (await authorize(database, actor, input, "read")).output(
				input.projectId,
				input.taskId,
				(lab, fleet) =>
					authorizeLab(database, actor, input, lab, fleet, "read"),
			);
		},
	};
}
