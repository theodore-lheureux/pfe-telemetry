import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { BookOpenIcon, ChartLineIcon, TagIcon } from "lucide-react";
import { PageHeader, pageTabClass } from "../components/page-header";
import type { ProjectReference } from "../organizations/contracts";

export function DefinitionsHeader({
	tab,
	reference,
}: {
	tab: "metrics" | "attributes";
	reference: ProjectReference;
}) {
	return (
		<PageHeader
			icon={BookOpenIcon}
			title={m.definitions()}
			description={m.definitions_description()}
			tabs={
				<>
					<Link
						to="/organizations/$organizationId/projects/$projectId/definitions"
						params={reference}
						activeOptions={{ exact: true }}
						className={pageTabClass(tab === "metrics")}
						aria-current={tab === "metrics" ? "page" : undefined}
					>
						<ChartLineIcon aria-hidden="true" className="size-4" />
						{m.definitions_metrics()}
					</Link>
					<Link
						to="/organizations/$organizationId/projects/$projectId/definitions/attributes"
						params={reference}
						className={pageTabClass(tab === "attributes")}
						aria-current={tab === "attributes" ? "page" : undefined}
					>
						<TagIcon aria-hidden="true" className="size-4" />
						{m.definitions_attributes()}
					</Link>
				</>
			}
		/>
	);
}
