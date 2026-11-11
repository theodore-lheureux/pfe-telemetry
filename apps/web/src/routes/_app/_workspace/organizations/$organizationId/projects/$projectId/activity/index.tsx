import { createFileRoute } from "@tanstack/react-router";
import {
	getExplorerColumns,
	listActivityPoints,
} from "@/activity/activity.functions";
import { ActivityPage } from "@/activity/activity-page";
import { attributeFields } from "@/activity/columns";
import { projectParams } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/activity/",
)({
	loader: async ({ params }) => {
		const reference = projectParams(params);
		// The first page projects the attribute columns this member has chosen.
		const columns = await getExplorerColumns({ data: reference });
		const fields = columns.data ? attributeFields(columns.data.columns) : [];
		return {
			columns,
			initial: await listActivityPoints({
				data: { ...reference, ...(fields.length ? { fields } : {}) },
			}),
		};
	},
	staleTime: 0,
	gcTime: 0,
	component: Explorer,
});
function Explorer() {
	const { user } = Route.useRouteContext(),
		reference = projectParams(Route.useParams());
	return (
		<ActivityPage
			key={`${user.id}/${reference.projectId}/explorer`}
			mode="explorer"
			userId={user.id}
			reference={reference}
			initial={Route.useLoaderData().initial}
			columns={Route.useLoaderData().columns}
		/>
	);
}
