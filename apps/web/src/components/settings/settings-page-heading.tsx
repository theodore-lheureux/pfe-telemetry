import { m } from "@recount/i18n/messages";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { ReactNode, Ref } from "react";
import { settingsScopes, settingsSearch } from "../settings-links";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbSeparator,
} from "../ui/breadcrumb";
import { settingsCatalog } from "./settings-catalog";

const settingsRoute = getRouteApi("/_app/_workspace/settings");

// Every settings page opens with the same heading: a breadcrumb naming the project,
// organization or account it belongs to, then the page title from the settings catalog.
export function SettingsPageHeading({
	description,
	actions,
	headingRef,
	headingId,
}: {
	description?: ReactNode;
	actions?: ReactNode;
	headingRef?: Ref<HTMLHeadingElement>;
	headingId?: string;
}) {
	const search = settingsRoute.useSearch();
	const { settingsOrganization, settingsProject } =
		settingsRoute.useRouteContext();
	const scope = settingsScopes[search.section];
	const parent =
		scope === "project"
			? { label: settingsProject?.name, section: "project" as const }
			: scope === "organization"
				? {
						label: settingsOrganization?.name,
						section: "organization" as const,
					}
				: { label: m.user_settings_group(), section: "user" as const };
	return (
		<div className="flex flex-wrap items-start justify-between gap-4">
			<div className="flex min-w-0 flex-col gap-2">
				<Breadcrumb>
					<BreadcrumbList>
						<BreadcrumbItem>{m.settings()}</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem className="min-w-0">
							<BreadcrumbLink asChild className="truncate">
								<Link
									to="/settings"
									search={settingsSearch(parent.section, search)}
								>
									{parent.label}
								</Link>
							</BreadcrumbLink>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
				<h1
					ref={headingRef}
					id={headingId}
					tabIndex={headingRef ? -1 : undefined}
					className="text-2xl font-semibold tracking-tight"
				>
					{settingsCatalog[search.section].label()}
				</h1>
				{description && (
					<p className="max-w-2xl text-sm text-muted-foreground">
						{description}
					</p>
				)}
			</div>
			{actions}
		</div>
	);
}
