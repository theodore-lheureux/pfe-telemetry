import { m } from "@recount/i18n/messages";
import { ExternalLinkIcon, ShieldCheckIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
			<div className="flex flex-col items-center gap-3 rounded-md border px-5 py-8 text-center">
				<ShieldCheckIcon
					aria-hidden="true"
					className="size-6 text-muted-foreground"
				/>
				<Badge variant="secondary">{m.settings_coming_soon()}</Badge>
				<p className="text-sm text-muted-foreground">
					{m.settings_planned_description()}
				</p>
				<Button asChild variant="outline">
					<a href={feature.url} target="_blank" rel="noopener noreferrer">
						{m.settings_view_ticket({ ticket: feature.ticket })}
						<ExternalLinkIcon aria-hidden="true" />
					</a>
				</Button>
			</div>
		</SettingsSection>
	);
}
