import { createFileRoute } from "@tanstack/react-router";
import {
	getAnalyticsCatalog,
	getSavedInsight,
	listInsightTags,
} from "@/analytics/analytics.functions";
import { InsightEditor } from "@/analytics/insight/insight-editor";
import { useUrlDraft } from "@/analytics/insight/use-url-draft";
import { useInsightTitle } from "@/analytics/saved/insight-title";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/insights/explore",
)({
	// The insight being edited lives in the URL, so it can be shared and reloaded. A saved
	// insight's ID names what it was opened from; `q` holds edits made since.
	validateSearch: (
		search: Record<string, unknown>,
	): { q?: string; insight?: string } => ({
		...(typeof search.q === "string" ? { q: search.q } : {}),
		...(typeof search.insight === "string" ? { insight: search.insight } : {}),
	}),
	loaderDeps: ({ search }) => ({ insight: search.insight }),
	loader: async ({ params, deps, location }) => {
		const reference = projectParams(params);
		const [catalog, tags, saved] = await Promise.all([
			getAnalyticsCatalog({ data: reference }),
			listInsightTags({ data: reference }),
			deps.insight
				? getSavedInsight({ data: { ...reference, insightId: deps.insight } })
				: null,
		]);
		return {
			catalog: routeData(catalog, location.href),
			tags: routeData(tags, location.href),
			saved: saved && routeData(saved, location.href),
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
	const { catalog, tags, saved } = Route.useLoaderData();
	const navigate = Route.useNavigate();
	const { q, insight } = Route.useSearch();
	const [draft, change] = useUrlDraft(q, saved?.draft, (next, replace) => {
		void navigate({
			search: { q: next, ...(insight ? { insight } : {}) },
			replace,
			resetScroll: false,
		});
	});
	const title = useInsightTitle({
		userId: user.id,
		reference,
		canWrite: project.role !== "viewer",
		saved,
		draft,
		tagSuggestions: tags,
	});
	return (
		<InsightEditor
			key={`${user.id}/${reference.projectId}`}
			userId={user.id}
			reference={reference}
			metrics={catalog.metrics}
			nodes={catalog.nodes}
			draft={draft}
			onDraft={change}
			heading={title.heading}
			description={title.description}
		/>
	);
}
