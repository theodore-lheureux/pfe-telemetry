import { m } from "@recount/i18n/messages";
import {
	type ErrorComponentProps,
	Link,
	useHydrated,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import { cn } from "cn";
import {
	ArrowLeftIcon,
	FileQuestionIcon,
	RotateCwIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ProgressStripe } from "./loading-bar";
import { useOptionalMutationFeedback } from "./mutation-feedback";
import { Button } from "./ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "./ui/empty";
import { Skeleton } from "./ui/skeleton";

/** Full-page status such as "not found" or "something went wrong", centred in its area. */
function StatusScreen({
	icon,
	title,
	description,
	tone = "default",
	children,
}: {
	icon: ReactNode;
	title: string;
	description: string;
	tone?: "default" | "destructive";
	children: ReactNode;
}) {
	return (
		<Empty className="min-h-[60vh] justify-center">
			<EmptyHeader>
				<EmptyMedia
					variant="icon"
					className={cn(
						tone === "destructive" && "bg-destructive/10 text-destructive",
					)}
				>
					{icon}
				</EmptyMedia>
				<EmptyTitle>
					<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
				</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			<EmptyContent className="flex-row flex-wrap justify-center gap-2">
				{children}
			</EmptyContent>
		</Empty>
	);
}

export function RoutePending() {
	return (
		<div className="flex flex-col gap-6 p-6">
			<p role="status" className="sr-only">
				{m.loading()}
			</p>
			<div aria-hidden="true" className="flex flex-col gap-6">
				<div className="flex flex-col gap-2">
					<Skeleton className="h-4 w-32" />
					<Skeleton className="h-7 w-56" />
				</div>
				<div className="flex flex-col gap-3">
					<Skeleton className="h-4 w-full max-w-xl" />
					<Skeleton className="h-4 w-full max-w-md" />
				</div>
				<Skeleton className="h-40 w-full max-w-3xl" />
			</div>
		</div>
	);
}

/**
 * A thin bar along the top of the window while a navigation loads. It waits briefly so
 * fast navigations do not flash it.
 */
export function NavigationProgress() {
	const loading = useRouterState({ select: (state) => state.isLoading });
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		if (!loading) {
			setVisible(false);
			return;
		}
		const timer = window.setTimeout(() => setVisible(true), 150);
		return () => window.clearTimeout(timer);
	}, [loading]);
	return (
		<div
			aria-hidden="true"
			className={cn(
				"pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden transition-opacity duration-200",
				visible ? "opacity-100" : "opacity-0",
			)}
		>
			<ProgressStripe />
		</div>
	);
}

export function RouteError({ reset }: ErrorComponentProps) {
	const router = useRouter();
	const hydrated = useHydrated();
	const setFeedback = useOptionalMutationFeedback();
	return (
		<StatusScreen
			tone="destructive"
			icon={<TriangleAlertIcon aria-hidden="true" />}
			title={m.error_title()}
			description={m.error_load()}
		>
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
				<RotateCwIcon aria-hidden="true" />
				{m.try_again()}
			</Button>
			<Button asChild variant="outline">
				<Link to="/">{m.go_home()}</Link>
			</Button>
		</StatusScreen>
	);
}

export function RouteNotFound() {
	const hydrated = useHydrated();
	return (
		<StatusScreen
			icon={<FileQuestionIcon aria-hidden="true" />}
			title={m.not_found()}
			description={m.not_found_description()}
		>
			<Button asChild>
				<Link to="/">{m.go_home()}</Link>
			</Button>
			<Button
				variant="outline"
				disabled={!hydrated}
				onClick={() => window.history.back()}
			>
				<ArrowLeftIcon aria-hidden="true" />
				{m.go_back()}
			</Button>
		</StatusScreen>
	);
}
