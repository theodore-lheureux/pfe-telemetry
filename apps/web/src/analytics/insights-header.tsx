import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import {
	LayoutDashboardIcon,
	LineChartIcon,
	TelescopeIcon,
} from "lucide-react";
import { PageHeader, pageTabClass } from "../components/page-header";
import type { ProjectReference } from "../organizations/contracts";

export function InsightsHeader({
	tab,
	reference,
}: {
	tab: "overview" | "explore";
	reference: ProjectReference;
}) {
	return (
		<PageHeader
			icon={LineChartIcon}
			title={m.insights()}
			description={m.insights_description()}
			tabs={
				<>
					<Link
						to="/organizations/$organizationId/projects/$projectId/insights"
						params={reference}
						activeOptions={{ exact: true }}
						className={pageTabClass(tab === "overview")}
						aria-current={tab === "overview" ? "page" : undefined}
					>
						<LayoutDashboardIcon aria-hidden="true" className="size-4" />
						{m.insight_tab_overview()}
					</Link>
					<Link
						to="/organizations/$organizationId/projects/$projectId/insights/explore"
						params={reference}
						className={pageTabClass(tab === "explore")}
						aria-current={tab === "explore" ? "page" : undefined}
					>
						<TelescopeIcon aria-hidden="true" className="size-4" />
						{m.insight_tab_explore()}
					</Link>
				</>
			}
		/>
	);
}
