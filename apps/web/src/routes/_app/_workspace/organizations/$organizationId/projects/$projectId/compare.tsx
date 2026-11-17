import { createFileRoute } from "@tanstack/react-router";
import { getAnalyticsCatalog } from "@/analytics/analytics.functions";
import {
	type ComparedSide,
	ComparePage,
} from "@/executions/compare/compare-page";
import type { ExecutionDetail } from "@/executions/contracts";
import { getExecution } from "@/executions/execution.functions";
import { parseExecutionKey } from "@/executions/validation";
import type { OperationResult } from "@/lib/operation-result";
import { projectParams, routeData } from "@/organizations/route-data";

interface CompareSearch {
	a?: string;
	b?: string;
}

const executionKey = (value: unknown) => {
	try {
		return parseExecutionKey(value);
	} catch {
		return undefined;
	}
};

/** A side whose key is not in the project stays on the page, so it can be replaced. */
function side(
	key: string,
	result: OperationResult<ExecutionDetail>,
	href: string,
): ComparedSide {
	if (result.error?.code === "NOT_FOUND") return { key, execution: null };
	return { key, execution: routeData(result, href) };
}

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/compare",
)({
	validateSearch: (search: Record<string, unknown>): CompareSearch => {
		const a = executionKey(search.a);
		const key = executionKey(search.b);
		// An execution is never compared with itself.
		const b = key === a ? undefined : key;
		// Explicit undefined replaces an invalid or repeated key in the raw search.
		return { a, b };
	},
	loaderDeps: ({ search }) => ({ a: search.a, b: search.b }),
	loader: async ({ params, deps, location }) => {
		const reference = projectParams(params);
		const read = (key: string | undefined) =>
			key ? getExecution({ data: { ...reference, executionKey: key } }) : null;
		// Each key is authorized and read on its own.
		const [catalog, a, b] = await Promise.all([
			getAnalyticsCatalog({ data: reference }),
			read(deps.a),
			read(deps.b),
		]);
		return {
			catalog: routeData(catalog, location.href).metrics,
			sides: [
				deps.a && a ? side(deps.a, a, location.href) : null,
				deps.b && b ? side(deps.b, b, location.href) : null,
			] as [ComparedSide | null, ComparedSide | null],
		};
	},
	staleTime: 0,
	gcTime: 0,
	component: Compare,
});

function Compare() {
	const { user } = Route.useRouteContext();
	const reference = projectParams(Route.useParams());
	const { catalog, sides } = Route.useLoaderData();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<ComparePage
			userId={user.id}
			reference={reference}
			sides={sides}
			catalog={catalog}
			onSelect={(index, key) =>
				void navigate({
					search: (previous) => ({
						...previous,
						[index === 0 ? "a" : "b"]: key,
					}),
				})
			}
			onSwap={() =>
				void navigate({
					search: {
						...(search.b ? { a: search.b } : {}),
						...(search.a ? { b: search.a } : {}),
					},
				})
			}
		/>
	);
}
