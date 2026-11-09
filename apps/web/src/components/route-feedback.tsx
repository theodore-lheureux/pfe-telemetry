import { m } from "@recount/i18n/messages";
import {
	type ErrorComponentProps,
	Link,
	useHydrated,
	useRouter,
} from "@tanstack/react-router";
import { useOptionalMutationFeedback } from "./mutation-feedback";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

export function RoutePending() {
	return (
		<div className="mx-auto max-w-xl px-6 py-12">
			<p role="status">{m.loading()}</p>
			<div aria-hidden="true" className="mt-4 space-y-3">
				<Skeleton className="h-7 w-48" />
				<Skeleton className="h-24 w-full" />
			</div>
		</div>
	);
}

export function RouteError({ reset }: ErrorComponentProps) {
	const router = useRouter();
	const hydrated = useHydrated();
	const setFeedback = useOptionalMutationFeedback();
	return (
		<div className="mx-auto flex max-w-xl flex-col items-start gap-4 px-6 py-12">
			<h1 className="text-2xl font-semibold">{m.error_title()}</h1>
			<Alert variant="destructive">
				<AlertDescription>{m.error_load()}</AlertDescription>
			</Alert>
			<Button
				disabled={!hydrated}
				onClick={() => {
					void router
						.invalidate({ sync: true })
						.then(() => {
							if (
								router.state.matches.every(
									(match) => match.status === "success",
								)
							)
								setFeedback?.(null);
							reset();
						})
						.catch(() => reset());
				}}
			>
				{m.try_again()}
			</Button>
			<Link to="/" className="text-sm underline">
				{m.go_home()}
			</Link>
		</div>
	);
}

export function RouteNotFound() {
	return (
		<div className="mx-auto flex max-w-xl flex-col items-start gap-4 px-6 py-12">
			<h1 className="text-2xl font-semibold">{m.not_found()}</h1>
			<p>{m.not_found_description()}</p>
			<Link to="/" className="text-sm underline">
				{m.go_home()}
			</Link>
		</div>
	);
}
