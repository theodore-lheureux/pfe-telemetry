import { createFileRoute, useRouter } from "@tanstack/react-router";
import { listRejectedDeliveries } from "@/activity/activity.functions";
import { ActivityHeader } from "@/activity/activity-header";
import { RejectedDeliveries } from "@/activity/rejected-deliveries";
import { projectParams } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/activity/rejected",
)({
	loader: ({ params }) =>
		listRejectedDeliveries({ data: projectParams(params) }),
	staleTime: 0,
	gcTime: 0,
	component: Rejected,
});

function Rejected() {
	const router = useRouter();
	return (
		<section className="flex min-w-0 flex-col gap-5">
			<ActivityHeader
				mode="rejected"
				reference={projectParams(Route.useParams())}
			/>
			<RejectedDeliveries
				result={Route.useLoaderData()}
				onRetry={() => router.invalidate()}
			/>
		</section>
	);
}
