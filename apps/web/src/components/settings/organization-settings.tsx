import { m } from "@recount/i18n/messages";
import { InfoIcon } from "lucide-react";
import type { OrganizationSummary } from "@/organizations/contracts";
import { updateOrganization } from "@/organizations/organization.functions";
import { RenameEntityForm } from "../entity-form";
import { OrganizationAvatar } from "../identity-avatar";
import { Alert, AlertDescription } from "../ui/alert";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { EntityIdentityRow } from "./entity-identity-row";
import { IdentifierCard } from "./identifier-field";
import { SettingsPageHeading } from "./settings-page-heading";
import { SettingsSection } from "./settings-section";

export function OrganizationSettings({
	organization,
}: {
	organization: OrganizationSummary;
}) {
	return (
		<div className="flex flex-col gap-8">
			<SettingsPageHeading />
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
				<EntityIdentityRow
					avatar={
						<OrganizationAvatar
							organization={organization}
							className="size-16 rounded-md text-xl"
						/>
					}
				>
					{organization.role === "member" ? (
						<div className="flex flex-col gap-2">
							<Label htmlFor="entity-name" className="sr-only">
								{m.name()}
							</Label>
							<Input id="entity-name" value={organization.name} disabled />
						</div>
					) : (
						<RenameEntityForm
							labelHidden
							requireChanged
							name={organization.name}
							reserveFeedbackLine={false}
							className="border-0 bg-transparent p-0"
							submitLabel={m.save_name()}
							save={({ name }, signal) =>
								updateOrganization({
									data: { organizationId: organization.id, name },
									signal,
								})
							}
						/>
					)}
				</EntityIdentityRow>
			</SettingsSection>
			<SettingsSection
				id="organization-identifier"
				title={m.organization_id()}
				description={m.settings_org_id_description()}
			>
				<IdentifierCard value={organization.id} />
			</SettingsSection>
		</div>
	);
}
