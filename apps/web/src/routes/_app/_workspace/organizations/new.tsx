import { m } from "@pfe/i18n/messages";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { EntityForm } from "@/components/entity-form";
import { PageHeading } from "@/components/workspace";
import { createOrganization } from "@/organizations/organization.functions";

export const Route = createFileRoute("/_app/_workspace/organizations/new")({
	head: () => ({
		meta: [{ title: `${m.create_organization()} · ${m.app_title()}` }],
	}),
	component: NewOrganization,
});
function NewOrganization() {
	const router = useRouter();
	return (
		<>
			<PageHeading title={m.create_organization()}>
				{m.you_will_become_its_owner_projects_are_private()}
			</PageHeading>
			<EntityForm
				slug
				submitLabel={m.create_organization()}
				save={(data) => createOrganization({ data })}
				onSuccess={async (organization, recover) => {
					const destination = {
						to: "/organizations/$organizationId",
						params: { organizationId: organization.id },
					} as const;
					recover(router.buildLocation(destination).href);
					await router.navigate(destination);
				}}
			/>
		</>
	);
}
