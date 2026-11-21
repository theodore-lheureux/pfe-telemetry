import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { CircleAlertIcon, HistoryIcon, RadioIcon } from "lucide-react";
import { PageHeader, pageTabClass } from "../components/page-header";
import type { ProjectReference } from "../organizations/contracts";

export function ActivityHeader({
	mode,
	reference,
}: {
	mode: "explorer" | "live" | "rejected";
	reference: ProjectReference;
}) {
	return (
		<PageHeader
			icon={RadioIcon}
			title={m.activity_title()}
			description={{
				explorer: m.activity_explorer_description,
				live: m.activity_live_description,
				rejected: m.activity_rejected_description,
			}[mode]()}
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
					<Link
						to="/organizations/$organizationId/projects/$projectId/activity/rejected"
						params={reference}
						preload={false}
						className={pageTabClass(mode === "rejected")}
						aria-current={mode === "rejected" ? "page" : undefined}
					>
						<CircleAlertIcon aria-hidden="true" className="size-4" />
						{m.activity_rejected_deliveries()}
					</Link>
				</>
			}
		/>
	);
}
