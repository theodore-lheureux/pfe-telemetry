import { m } from "@recount/i18n/messages";
import { createFileRoute } from "@tanstack/react-router";
import { EmailChangeConfirmation } from "@/components/settings/email-change-confirmation";

export const Route = createFileRoute("/_app/email-change")({
	validateSearch: (search: Record<string, unknown>) => ({
		token: typeof search.token === "string" ? search.token : "",
		accountId: typeof search.accountId === "string" ? search.accountId : "",
	}),
	headers: () => ({
		"Cache-Control": "private, no-store",
		"Referrer-Policy": "no-referrer",
	}),
	head: () => ({
		meta: [
			{ title: `${m.profile_email_change_title()} · ${m.app_title()}` },
			{ name: "referrer", content: "no-referrer" },
		],
	}),
	component: EmailChangeRoute,
});

function EmailChangeRoute() {
	const { user } = Route.useRouteContext();
	const { token, accountId } = Route.useSearch();
	return (
		<EmailChangeConfirmation
			key={`${user.id}:${token}:${accountId}`}
			user={user}
			token={token}
			accountId={accountId}
		/>
	);
}
