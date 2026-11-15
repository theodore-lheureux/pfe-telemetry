import { m } from "@recount/i18n/messages";
import {
	BookmarkIcon,
	LayoutDashboardIcon,
	type LucideIcon,
	PanelsTopLeftIcon,
	TelescopeIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "../components/page-header";

export type AnalyticsSection =
	| "overview"
	| "dashboards"
	| "explore"
	| "insights";

const SECTION: Record<
	AnalyticsSection,
	{ icon: LucideIcon; title: () => string; description: () => string }
> = {
	overview: {
		icon: LayoutDashboardIcon,
		title: m.overview,
		description: m.overview_description,
	},
	dashboards: {
		icon: PanelsTopLeftIcon,
		title: m.dashboards,
		description: m.dashboards_description,
	},
	explore: {
		icon: TelescopeIcon,
		title: m.insight_tab_explore,
		description: m.insights_description,
	},
	insights: {
		icon: BookmarkIcon,
		title: m.insights,
		description: m.saved_insights_description,
	},
};

/** The header of an analytics page: its section's title, or a replacement heading. */
export function AnalyticsHeader({
	section,
	heading,
	description,
	actions,
}: {
	section: AnalyticsSection;
	/** Replaces the page title, such as the open insight's name. */
	heading?: ReactNode;
	description?: ReactNode;
	/** Controls pinned at the right of the title. */
	actions?: ReactNode;
}) {
	const { icon, title, description: fallback } = SECTION[section];
	return (
		<PageHeader
			icon={icon}
			title={title()}
			heading={heading}
			actions={actions}
			description={description ?? fallback()}
		/>
	);
}
