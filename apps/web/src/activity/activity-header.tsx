import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { HistoryIcon, RadioIcon } from "lucide-react";
import { PageHeader, pageTabClass } from "../components/page-header";
import type { ProjectReference } from "../organizations/contracts";

export function ActivityHeader({
	mode,
	reference,
}: {
	mode: "explorer" | "live";
	reference: ProjectReference;
}) {
	return (
		<PageHeader
			icon={RadioIcon}
			title={m.activity_title()}
			description={
				mode === "live"
					? m.activity_live_description()
					: m.activity_explorer_description()
			}
			tabs={
				<>
					<Link
						to="/organizations/$organizationId/projects/$projectId/activity"
						params={reference}
						activeOptions={{ exact: true }}
						className={pageTabClass(mode === "explorer")}
						aria-current={mode === "explorer" ? "page" : undefined}
					>
						<HistoryIcon aria-hidden="true" className="size-4" />
						{m.activity_explorer()}
					</Link>
					<Link
						to="/organizations/$organizationId/projects/$projectId/activity/live"
						params={reference}
						className={pageTabClass(mode === "live")}
						aria-current={mode === "live" ? "page" : undefined}
					>
						<RadioIcon aria-hidden="true" className="size-4" />
						{m.activity_live()}
					</Link>
				</>
			}
		/>
	);
}
