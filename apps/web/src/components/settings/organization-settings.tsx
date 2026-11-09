import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import { PageHeading } from "@/components/workspace";
import type { OrganizationSummary } from "@/organizations/contracts";

export function OrganizationSettings({
	organization,
}: {
	organization: OrganizationSummary;
}) {
	return (
		<>
			<PageHeading title={m.organization_settings()} />
			<dl className="grid max-w-xl gap-4 text-sm">
				<div id="organization-name">
					<dt className="text-muted-foreground">{m.name()}</dt>
					<dd>{organization.name}</dd>
				</div>
				<div id="organization-slug">
					<dt className="text-muted-foreground">{m.slug()}</dt>
					<dd>{organization.slug}</dd>
				</div>
				<div id="organization-role">
					<dt className="text-muted-foreground">{m.your_role()}</dt>
					<dd>{roleLabel(organization.role)}</dd>
				</div>
				<div id="organization-identifier">
					<dt className="text-muted-foreground">{m.organization_id()}</dt>
					<dd className="break-all font-mono text-xs">{organization.id}</dd>
				</div>
			</dl>
		</>
	);
}
