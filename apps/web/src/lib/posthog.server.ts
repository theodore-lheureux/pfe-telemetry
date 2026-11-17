import { PostHog } from "posthog-node";
import { InputError } from "./input-error";
import { OperationError } from "./operation-error";

let client: PostHog | null | undefined;

// The browser's public project token and host, baked in at build time, also
// configure server capture; the environment can override them.
function posthog() {
	if (client !== undefined) return client;
	const token =
		process.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN ??
		import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;
	const host =
		process.env.VITE_PUBLIC_POSTHOG_HOST ??
		import.meta.env.VITE_PUBLIC_POSTHOG_HOST;
	client = token && host ? new PostHog(token, { host }) : null;
	return client;
}

/** Reports unexpected server failures; rejected input and handled outcomes are not bugs. */
export function captureServerException(error: unknown, distinctId?: string) {
	if (error instanceof InputError || error instanceof OperationError) return;
	posthog()?.captureException(error, distinctId);
}

export async function closePostHog() {
	await client?.shutdown(3000).catch(() => {});
	client = undefined;
}
