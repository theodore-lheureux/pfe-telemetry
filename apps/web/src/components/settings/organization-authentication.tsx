import { m } from "@recount/i18n/messages";
import { Badge } from "../ui/badge";
import { PageHeading } from "../workspace";
import { authenticationFeatures } from "./authentication-features";
import { PlannedSetting } from "./planned-setting";
import { SettingsSection } from "./settings-section";

export function OrganizationAuthentication() {
	return (
		<div className="flex flex-col gap-8">
			<PageHeading
				title={m.settings_page({ page: m.settings_authentication() })}
			/>
			<SettingsSection
				id="available-authentication"
				title={m.settings_current_auth()}
				description={m.settings_current_auth_description()}
			>
				<div className="flex flex-wrap gap-2">
					<Badge variant="outline">{m.email_code_method()}</Badge>
					<Badge variant="outline">{m.passkeys()}</Badge>
				</div>
			</SettingsSection>
			{authenticationFeatures.map((feature) => (
				<PlannedSetting key={feature.id} feature={feature} />
			))}
		</div>
	);
}
