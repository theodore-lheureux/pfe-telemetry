import { roleLabel } from "@pfe/i18n/labels";
import { m } from "@pfe/i18n/messages";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "@/components/workspace";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/settings",
)({
	head: () => ({
		meta: [{ title: `${m.organization_settings()} · ${m.app_title()}` }],
	}),
	component: OrganizationSettings,
});
function OrganizationSettings() {
	const { organization } = Route.useRouteContext();
	return (
		<>
			<PageHeading title={m.organization_settings()}>
				{m.organization_metadata_and_your_current_access()}
			</PageHeading>
			<dl className="grid max-w-xl gap-4 rounded-xl border p-5 text-sm">
				<div>
					<dt className="text-muted-foreground">{m.name()}</dt>
					<dd>{organization.name}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">{m.slug()}</dt>
					<dd>{organization.slug}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">{m.your_role()}</dt>
					<dd>{roleLabel(organization.role)}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">{m.organization_id()}</dt>
					<dd className="break-all font-mono text-xs">{organization.id}</dd>
				</div>
			</dl>
			<p className="text-sm text-muted-foreground">
				{m.organization_renaming_and_deletion_are_not_available()}
			</p>
		</>
	);
}
