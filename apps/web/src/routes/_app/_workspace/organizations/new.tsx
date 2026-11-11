import { m } from "@recount/i18n/messages";
import { createFileRoute } from "@tanstack/react-router";
import { CreateEntityForm } from "@/components/entity-form";
import { PageHeading } from "@/components/workspace";
import { createOrganization } from "@/organizations/organization.functions";

export const Route = createFileRoute("/_app/_workspace/organizations/new")({
	head: () => ({
		meta: [{ title: `${m.create_organization()} · ${m.app_title()}` }],
	}),
	component: NewOrganization,
});
function NewOrganization() {
	return (
		<>
			<PageHeading title={m.create_organization()}>
				{m.you_will_become_its_owner_projects_are_private()}
			</PageHeading>
			<CreateEntityForm
				slugFallback="organization"
				submitLabel={m.create_organization()}
				save={(data, signal) => createOrganization({ data, signal })}
				onSuccess={async (organization, navigate) => {
					const destination = {
						to: "/organizations/$organizationId",
						params: { organizationId: organization.id },
					} as const;
					await navigate(destination);
				}}
			/>
		</>
	);
}
