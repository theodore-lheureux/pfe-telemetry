import { m } from "@recount/i18n/messages";
import { InfoIcon } from "lucide-react";
import { PageHeading } from "@/components/workspace";
import type { OrganizationSummary } from "@/organizations/contracts";
import { updateOrganization } from "@/organizations/organization.functions";
import { EntityForm } from "../entity-form";
import { OrganizationAvatar } from "../identity-avatar";
import { Alert, AlertDescription } from "../ui/alert";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { IdentifierField } from "./identifier-field";
import { SettingsSection } from "./settings-section";

export function OrganizationSettings({
	organization,
}: {
	organization: OrganizationSummary;
}) {
	return (
		<div className="flex flex-col gap-8">
			<PageHeading title={m.settings_page({ page: m.settings_general() })} />
			{organization.role === "member" && (
				<Alert>
					<InfoIcon aria-hidden="true" />
					<AlertDescription>{m.settings_org_admin_notice()}</AlertDescription>
				</Alert>
			)}
			<SettingsSection
				id="organization-name"
				title={m.settings_name_logo()}
				description={m.settings_org_identity_description()}
			>
				<div className="flex items-start gap-6">
					<OrganizationAvatar
						organization={organization}
						className="size-16 rounded-md text-xl"
					/>
					<div className="min-w-0 flex-1 max-w-lg">
						{organization.role !== "member" ? (
							<EntityForm
								name={organization.name}
								requireChanged
								reserveFeedbackLine={false}
								className="border-0 bg-transparent p-0"
								submitLabel={m.save_name()}
								save={({ name }) =>
									updateOrganization({
										data: { organizationId: organization.id, name },
									})
								}
								onSuccess={async () => {}}
							/>
						) : (
							<div className="flex flex-col gap-2">
								<Label htmlFor="entity-name">{m.name()}</Label>
								<Input id="entity-name" value={organization.name} disabled />
							</div>
						)}
					</div>
				</div>
				<p className="text-xs text-muted-foreground">
					{m.settings_logo_unavailable()}
				</p>
			</SettingsSection>
			<SettingsSection
				id="organization-identifier"
				title={m.organization_id()}
				description={m.settings_org_id_description()}
			>
				<div className="max-w-2xl rounded-md border bg-card p-4">
					<IdentifierField value={organization.id} />
				</div>
			</SettingsSection>
			<SettingsSection id="organization-slug" title={m.slug()}>
				<div className="max-w-2xl">
					<IdentifierField value={organization.slug} />
				</div>
			</SettingsSection>
		</div>
	);
}
