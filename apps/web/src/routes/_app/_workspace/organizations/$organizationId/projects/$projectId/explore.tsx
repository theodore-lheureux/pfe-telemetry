import { m } from "@recount/i18n/messages";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
	getAnalyticsCatalog,
	getSavedInsight,
	listInsightTags,
} from "@/analytics/analytics.functions";
import { calculationDraft } from "@/analytics/calculated-draft";
import { getCalculatedMetric } from "@/analytics/calculated-metrics.functions";
import { encodeDraft } from "@/analytics/insight/draft";
import { InsightEditor } from "@/analytics/insight/insight-editor";
import { useUrlDraft } from "@/analytics/insight/use-url-draft";
import { useInsightTitle } from "@/analytics/saved/insight-title";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/explore",
)({
	// The insight being edited lives in the URL, so it can be shared and reloaded. A saved
	// insight's ID names what it was opened from; `q` holds edits made since.
	validateSearch: (
		search: Record<string, unknown>,
	): { q?: string; insight?: string; calculated?: string } => ({
		...(typeof search.q === "string" ? { q: search.q } : {}),
		...(typeof search.insight === "string" ? { insight: search.insight } : {}),
		...(typeof search.calculated === "string"
			? { calculated: search.calculated }
			: {}),
	}),
	loaderDeps: ({ search }) => ({
		insight: search.insight,
		calculated: search.calculated,
	}),
	loader: async ({ params, deps, location }) => {
		const reference = projectParams(params);
		const [catalog, tags, saved, calculated] = await Promise.all([
			getAnalyticsCatalog({ data: reference }),
			listInsightTags({ data: reference }),
			deps.insight
				? getSavedInsight({ data: { ...reference, insightId: deps.insight } })
				: null,
			deps.calculated
				? getCalculatedMetric({
						data: { ...reference, metric: deps.calculated },
					})
				: null,
		]);
		return {
			catalog: routeData(catalog, location.href),
			tags: routeData(tags, location.href),
			saved: saved && routeData(saved, location.href),
			calculated: calculated && routeData(calculated, location.href),
		};
	},
	staleTime: 0,
	gcTime: 0,
	// Editing changes only `q`; data reloads when the page is entered or a save
	// invalidates it.
	shouldReload: ({ cause }) => cause === "enter",
	component: Explore,
});

function Explore() {
	const { user, project } = Route.useRouteContext();
	const reference = projectParams(Route.useParams());
	const { catalog, tags, saved, calculated } = Route.useLoaderData();
	const navigate = Route.useNavigate();
	const { q, insight, calculated: calculatedReference } = Route.useSearch();
	const [draft, change] = useUrlDraft(
		q,
		saved?.draft ??
			(calculated ? encodeDraft(calculationDraft(calculated)) : undefined),
		(next, replace) => {
			void navigate({
				search: {
					q: next,
					...(insight ? { insight } : {}),
					...(calculatedReference ? { calculated: calculatedReference } : {}),
				},
				replace,
				resetScroll: false,
			});
		},
	);
	const title = useInsightTitle({
		userId: user.id,
		reference,
		canWrite: project.role !== "viewer",
		saved,
		draft,
		tagSuggestions: tags,
		metrics: catalog.metrics,
	});
	let description: ReactNode = title.description;
	if (calculated)
		description = calculated.builtIn
			? m.calculated_copy_description()
			: m.calculated_edit_warning();
	return (
		<InsightEditor
			key={`${user.id}/${reference.projectId}`}
			userId={user.id}
			canWrite={project.role !== "viewer"}
			editingCalculation={calculated ?? undefined}
			reference={reference}
			metrics={catalog.metrics}
			nodes={catalog.nodes}
			draft={draft}
			onDraft={change}
			heading={
				calculated ? (
					<h1 className="text-xl font-semibold">{calculated.name}</h1>
				) : (
					title.heading
				)
			}
			description={description}
		/>
	);
}
