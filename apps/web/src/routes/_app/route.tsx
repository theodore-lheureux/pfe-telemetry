import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getCurrentUser } from "@/auth/session.functions";
import { AppShell } from "@/components/app-shell";

export const Route = createFileRoute("/_app")({
	beforeLoad: async ({ location, context }) => {
		await context.authentication.beforePrivateRead();
		const user = await getCurrentUser();
		if (!user)
			throw redirect({
				to: "/login",
				search: { redirect: location.href },
			});
		return { user };
	},
	headers: () => ({ "Cache-Control": "private, no-store" }),
	staleTime: 0,
	gcTime: 0,
	component: App,
});

function App() {
	const { user } = Route.useRouteContext();
	return (
		<AppShell user={user}>
			<Outlet />
		</AppShell>
	);
}
