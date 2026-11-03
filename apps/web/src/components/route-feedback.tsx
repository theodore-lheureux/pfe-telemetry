import {
	type ErrorComponentProps,
	Link,
	useRouter,
} from "@tanstack/react-router";
import { Button } from "./ui/button";

export function RoutePending() {
	return (
		<main className="mx-auto max-w-xl px-6 py-12">
			<p role="status">Loading…</p>
		</main>
	);
}

export function RouteError({ reset }: ErrorComponentProps) {
	const router = useRouter();
	return (
		<main className="mx-auto flex max-w-xl flex-col items-start gap-4 px-6 py-12">
			<h1 className="text-2xl font-semibold">Something went wrong</h1>
			<p role="alert">We could not load this page. Please try again.</p>
			<Button
				onClick={() => {
					void router.invalidate();
					reset();
				}}
			>
				Try again
			</Button>
			<Link to="/" className="text-sm underline">
				Go home
			</Link>
		</main>
	);
}

export function RouteNotFound() {
	return (
		<main className="mx-auto flex max-w-xl flex-col items-start gap-4 px-6 py-12">
			<h1 className="text-2xl font-semibold">Page not found</h1>
			<p>This page does not exist.</p>
			<Link to="/" className="text-sm underline">
				Go home
			</Link>
		</main>
	);
}
