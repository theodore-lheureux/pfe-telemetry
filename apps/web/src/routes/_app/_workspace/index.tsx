import { roleLabel } from "@pfe/i18n/labels";
import { m } from "@pfe/i18n/messages";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeading } from "@/components/workspace";

export const Route = createFileRoute("/_app/_workspace/")({
	head: () => ({
		meta: [{ title: `${m.your_organizations()} · ${m.app_title()}` }],
	}),
	component: Organizations,
});

function Organizations() {
	const { organizations } = Route.useRouteContext();
	return (
		<>
			<PageHeading title={m.your_organizations()}>
				{m.choose_an_organization_to_open_its_projects_and()}
			</PageHeading>
			{organizations.length ? (
				<ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{organizations.map((organization) => (
						<li key={organization.id}>
							<Link
								to="/organizations/$organizationId"
								params={{ organizationId: organization.id }}
								className="flex h-full flex-col gap-3 rounded-lg border bg-card p-5 text-card-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
							>
								<span className="font-semibold">{organization.name}</span>
								<span className="text-sm text-muted-foreground">
									{organization.slug} · {roleLabel(organization.role)}
								</span>
							</Link>
						</li>
					))}
				</ul>
			) : (
				<EmptyState title={m.create_your_first_organization()}>
					<p className="max-w-xl text-sm text-muted-foreground">
						{m.organizations_keep_your_teams_projects_together_create_one()}
					</p>
					<Button asChild>
						<Link to="/organizations/new">{m.create_organization()}</Link>
					</Button>
				</EmptyState>
			)}
		</>
	);
}
