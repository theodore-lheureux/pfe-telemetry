import { createFileRoute } from "@tanstack/react-router";
import { getAnalyticsCatalog } from "@/analytics/analytics.functions";
import { InsightEditor } from "@/analytics/insight/insight-editor";
import { useUrlDraft } from "@/analytics/insight/use-url-draft";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/insights/explore",
)({
	// The insight being edited lives in the URL, so it can be shared and reloaded.
	validateSearch: (search: Record<string, unknown>): { q?: string } =>
		typeof search.q === "string" ? { q: search.q } : {},
	loader: async ({ params, location }) =>
		routeData(
			await getAnalyticsCatalog({ data: projectParams(params) }),
			location.href,
		),
	staleTime: 0,
	gcTime: 0,
	// Editing changes only the search; the catalog reloads when the page is entered.
	shouldReload: ({ cause }) => cause === "enter",
	component: Explore,
});

function Explore() {
	const { user } = Route.useRouteContext();
	const reference = projectParams(Route.useParams());
	const catalog = Route.useLoaderData();
	const navigate = Route.useNavigate();
	const { q } = Route.useSearch();
	const [draft, change] = useUrlDraft(q, (next, replace) => {
		void navigate({ search: { q: next }, replace, resetScroll: false });
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
		/>
	);
}
