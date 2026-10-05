import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	return (
		<main className="mx-auto flex min-h-svh max-w-3xl flex-col items-start justify-center gap-6 px-6">
			<h1 className="text-2xl font-semibold tracking-tight">Telemetry</h1>
			<Button asChild variant="outline">
				<a href="https://github.com/theodore-lheureux/pfe-telemetry">
					Project repository
				</a>
			</Button>
		</main>
	);
}
