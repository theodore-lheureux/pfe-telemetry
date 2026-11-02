import { m } from "@pfe/i18n/messages";
import { getLocale } from "@pfe/i18n/runtime";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { LanguageSwitcher } from "../components/language-switcher";
import { LocaleSafety } from "../components/locale-safety";
import { MutationFeedback } from "../components/mutation-feedback";
import { RouteNotFound } from "../components/route-feedback";
import { clearValidation, localizeValidation } from "../lib/input-validation";
import css from "../styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
	{
		head: () => ({
			meta: [
				{ charSet: "utf-8" },
				{ name: "viewport", content: "width=device-width, initial-scale=1" },
				{ title: m.app_title() },
			],
			links: [{ rel: "stylesheet", href: css }],
		}),
		component: Outlet,
		shellComponent: RootDocument,
		notFoundComponent: RouteNotFound,
	},
);

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang={getLocale()}>
			<head>
				<HeadContent />
			</head>
			<body
				onInvalidCapture={(event) => localizeValidation(event.target)}
				onInputCapture={(event) => clearValidation(event.target)}
				onChangeCapture={(event) => clearValidation(event.target)}
			>
				<LocaleSafety>
					<div className="flex justify-end px-6 pt-3">
						<LanguageSwitcher />
					</div>
					<MutationFeedback>{children}</MutationFeedback>
				</LocaleSafety>
				<Scripts />
			</body>
		</html>
	);
}
