import { createFileRoute } from "@tanstack/react-router";
import {
	getExplorerColumns,
	listActivityPoints,
	listRejectedDeliveries,
} from "@/activity/activity.functions";
import { ActivityPage } from "@/activity/activity-page";
import { attributeFields } from "@/activity/columns";
import { RejectedDeliveries } from "@/activity/rejected-deliveries";
import { projectParams } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/activity/",
)({
	// Definitions link here with a metric, so its points open already filtered.
	validateSearch: (search: Record<string, unknown>): { metric?: string } =>
		typeof search.metric === "string" ? { metric: search.metric } : {},
	loaderDeps: ({ search }) => ({ metric: search.metric }),
	loader: async ({ params, deps }) => {
		const reference = projectParams(params);
		// The first page projects the attribute columns this member has chosen.
		const columns = await getExplorerColumns({ data: reference });
		const fields = columns.data ? attributeFields(columns.data.columns) : [];
		const [initial, rejected] = await Promise.all([
			listActivityPoints({
				data: {
					...reference,
					...(fields.length ? { fields } : {}),
					...(deps.metric ? { metric: deps.metric } : {}),
				},
			}),
			listRejectedDeliveries({ data: reference }),
		]);
		return {
			columns,
			initial,
			rejected,
		};
	},
	staleTime: 0,
	gcTime: 0,
	component: Explorer,
});
function Explorer() {
	const { user } = Route.useRouteContext(),
		reference = projectParams(Route.useParams()),
		{ metric } = Route.useSearch();
	return (
		<>
			<ActivityPage
				key={`${user.id}/${reference.projectId}/explorer/${metric ?? ""}`}
				mode="explorer"
				userId={user.id}
				reference={reference}
				initial={Route.useLoaderData().initial}
				columns={Route.useLoaderData().columns}
				metric={metric}
			/>
			<RejectedDeliveries result={Route.useLoaderData().rejected} />
		</>
	);
}
