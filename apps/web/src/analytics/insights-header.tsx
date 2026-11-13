import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import {
	BookmarkIcon,
	LayoutDashboardIcon,
	LineChartIcon,
	PanelsTopLeftIcon,
	TelescopeIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader, pageTabClass } from "../components/page-header";
import type { ProjectReference } from "../organizations/contracts";

export function InsightsHeader({
	tab,
	reference,
	heading,
	description,
	actions,
}: {
	tab: "overview" | "dashboards" | "explore" | "saved";
	reference: ProjectReference;
	/** Replaces the page title, such as the open insight's name. */
	heading?: ReactNode;
	description?: ReactNode;
	/** Controls pinned at the right of the title. */
	actions?: ReactNode;
}) {
	return (
		<PageHeader
			icon={LineChartIcon}
			title={m.insights()}
			heading={heading}
			actions={actions}
			description={description ?? m.insights_description()}
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
						to="/organizations/$organizationId/projects/$projectId/insights/dashboards"
						params={reference}
						className={pageTabClass(tab === "dashboards")}
						aria-current={tab === "dashboards" ? "page" : undefined}
					>
						<PanelsTopLeftIcon aria-hidden="true" className="size-4" />
						{m.dashboards()}
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
					<Link
						to="/organizations/$organizationId/projects/$projectId/insights/saved"
						params={reference}
						className={pageTabClass(tab === "saved")}
						aria-current={tab === "saved" ? "page" : undefined}
					>
						<BookmarkIcon aria-hidden="true" className="size-4" />
						{m.insight_tab_saved()}
					</Link>
				</>
			}
		/>
	);
}
