import { asc, eq } from "drizzle-orm";
import type { createAuth } from "../auth/create-auth.server";
import type { getDatabase } from "../db/client.server";
import { member, organization } from "../db/schema";
import {
	type Actor,
	requireOrganization,
	resolveOrganizationRole,
} from "./access.server";
import type { OrganizationInput, OrganizationSummary } from "./contracts";

type Database = ReturnType<typeof getDatabase>;
type Auth = ReturnType<typeof createAuth>;

export async function listOrganizations(database: Database, actor: Actor) {
	const entries = await database
		.select({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			logo: organization.logo,
			role: member.role,
		})
		.from(member)
		.innerJoin(organization, eq(organization.id, member.organizationId))
		.where(eq(member.userId, actor.id))
		.orderBy(asc(organization.name), asc(organization.id));
	return entries.flatMap((entry) => {
		const role = resolveOrganizationRole(entry.role);
		return role ? [{ ...entry, role }] : [];
	}) satisfies OrganizationSummary[];
}

export async function getOrganization(
	database: Database,
	actor: Actor,
	organizationId: string,
) {
	const entry = await requireOrganization(database, actor, organizationId);
	return {
		id: entry.id,
		name: entry.name,
		slug: entry.slug,
		logo: entry.logo,
		role: entry.role,
	} satisfies OrganizationSummary;
}

export async function createOrganization(
	auth: Auth,
	headers: Headers,
	input: OrganizationInput,
) {
	const created = await auth.api.createOrganization({
		headers,
		body: { ...input, keepCurrentActiveOrganization: true },
	});
	if (!created)
		throw new Error("Organization creation returned no organization");
	return {
		id: created.id,
		name: created.name,
		slug: created.slug,
		logo: created.logo ?? null,
		role: "owner",
	} satisfies OrganizationSummary;
}
