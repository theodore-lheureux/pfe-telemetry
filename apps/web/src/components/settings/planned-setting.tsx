import { m } from "@recount/i18n/messages";
import { ComingSoonNotice } from "./coming-soon-notice";
import { SettingsSection } from "./settings-section";

export function PlannedSetting({
	feature,
}: {
	feature: {
		id: string;
		label: () => string;
		description: () => string;
		ticket: string;
		url: string;
	};
}) {
	return (
		<SettingsSection
			id={feature.id}
			title={feature.label()}
			description={feature.description()}
		>
			<ComingSoonNotice ticket={{ name: feature.ticket, url: feature.url }}>
				{m.settings_planned_description()}
			</ComingSoonNotice>
		</SettingsSection>
	);
}
