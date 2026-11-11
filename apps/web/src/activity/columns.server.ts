import { and, eq } from "drizzle-orm";
import type { getDatabase } from "../db/client.server";
import { explorerColumnDefault, explorerColumnPreference } from "../db/schema";
import {
	type Actor,
	requireOrganization,
	requireProject,
} from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import {
	DEFAULT_COLUMNS,
	type ExplorerColumn,
	type ExplorerColumnSettings,
	sameColumns,
	storedColumns,
} from "./columns";

type Database = ReturnType<typeof getDatabase>;

export type SaveColumnsInput = ProjectReference & {
	columns: ExplorerColumn[];
	/** Also make these columns the project default; requires project administration. */
	asDefault: boolean;
};

async function settings(
	database: Database,
	reference: ProjectReference,
	memberId: string,
	canSetDefault: boolean,
): Promise<ExplorerColumnSettings> {
	const [projectDefault] = await database
		.select({ columns: explorerColumnDefault.columns })
		.from(explorerColumnDefault)
		.where(
			and(
				eq(explorerColumnDefault.projectId, reference.projectId),
				eq(explorerColumnDefault.organizationId, reference.organizationId),
			),
		);
	const [own] = await database
		.select({ columns: explorerColumnPreference.columns })
		.from(explorerColumnPreference)
		.where(
			and(
				eq(explorerColumnPreference.projectId, reference.projectId),
				eq(explorerColumnPreference.organizationId, reference.organizationId),
				eq(explorerColumnPreference.memberId, memberId),
			),
		);
	const defaults = projectDefault
		? storedColumns(projectDefault.columns, DEFAULT_COLUMNS)
		: DEFAULT_COLUMNS;
	return {
		columns: own ? storedColumns(own.columns, defaults) : defaults,
		defaults,
		canSetDefault,
	};
}

export async function readColumns(
	database: Database,
	actor: Actor,
	reference: ProjectReference,
) {
	const summary = await requireProject(database, actor, reference);
	const membership = await requireOrganization(
		database,
		actor,
		reference.organizationId,
	);
	return settings(
		database,
		reference,
		membership.memberId,
		summary.role === "admin",
	);
}

export async function saveColumns(
	database: Database,
	actor: Actor,
	input: SaveColumnsInput,
) {
	const summary = await requireProject(
		database,
		actor,
		input,
		input.asDefault ? "admin" : "read",
	);
	const membership = await requireOrganization(
		database,
		actor,
		input.organizationId,
	);
	const reference = {
		organizationId: input.organizationId,
		projectId: input.projectId,
	};
	await database.transaction(async (transaction) => {
		if (input.asDefault)
			await transaction
				.insert(explorerColumnDefault)
				.values({ ...reference, columns: input.columns })
				.onConflictDoUpdate({
					target: [
						explorerColumnDefault.projectId,
						explorerColumnDefault.organizationId,
					],
					set: { columns: input.columns, updatedAt: new Date() },
				});
		const [projectDefault] = await transaction
			.select({ columns: explorerColumnDefault.columns })
			.from(explorerColumnDefault)
			.where(
				and(
					eq(explorerColumnDefault.projectId, reference.projectId),
					eq(explorerColumnDefault.organizationId, reference.organizationId),
				),
			);
		const defaults = projectDefault
			? storedColumns(projectDefault.columns, DEFAULT_COLUMNS)
			: DEFAULT_COLUMNS;
		const own = and(
			eq(explorerColumnPreference.projectId, reference.projectId),
			eq(explorerColumnPreference.organizationId, reference.organizationId),
			eq(explorerColumnPreference.memberId, membership.memberId),
		);
		// Matching the default stores nothing, so later default changes still apply.
		if (sameColumns(input.columns, defaults))
			await transaction.delete(explorerColumnPreference).where(own);
		else
			await transaction
				.insert(explorerColumnPreference)
				.values({
					...reference,
					memberId: membership.memberId,
					columns: input.columns,
				})
				.onConflictDoUpdate({
					target: [
						explorerColumnPreference.projectId,
						explorerColumnPreference.memberId,
					],
					set: { columns: input.columns, updatedAt: new Date() },
				});
	});
	return settings(
		database,
		reference,
		membership.memberId,
		summary.role === "admin",
	);
}
