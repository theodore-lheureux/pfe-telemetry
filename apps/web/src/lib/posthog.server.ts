import { PostHog } from "posthog-node";
import { InputError } from "./input-error";
import { OperationError } from "./operation-error";

export type PostHogConfig = { token: string; host: string };

/** Runtime settings, so one build can be promoted between environments. */
export function readPostHogConfig(): PostHogConfig | null {
	const token = process.env.RECOUNT_POSTHOG_PROJECT_TOKEN;
	const host = process.env.RECOUNT_POSTHOG_HOST;
	return token && host ? { token, host } : null;
}

let client: PostHog | null | undefined;

function posthog() {
	if (client !== undefined) return client;
	const config = readPostHogConfig();
	client = config ? new PostHog(config.token, { host: config.host }) : null;
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
