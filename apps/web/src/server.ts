import { paraglideMiddleware } from "@recount/i18n/server";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { useNitroHooks as nitroHooks } from "nitro/app";
import { drainProcessAuthEmailDelivery } from "./auth/email-delivery.server";
import { closeDatabase } from "./db/client.server";
import { closeTelemetryClient } from "./executions/telemetry.server";

async function close() {
	let failed = false;
	try {
		await drainProcessAuthEmailDelivery(true);
	} catch {
		failed = true;
	}
	const results = await Promise.allSettled([
		closeTelemetryClient(),
		closeDatabase(),
	]);
	if (failed || results.some((result) => result.status === "rejected")) {
		process.exitCode = 1;
		throw new Error("Application resources failed to close");
	}
}

let registeredClose = false;
export default createServerEntry({
	async fetch(request, options) {
		if (!registeredClose) {
			// Register from the SSR graph so cleanup owns the resources used by Start.
			nitroHooks().hook("close", close);
			registeredClose = true;
		}
		return paraglideMiddleware(request, async () => {
			const response = await handler.fetch(request, options);
			const headers = new Headers(response.headers);
			headers.set("Cache-Control", "private, no-store");
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		});
	},
});
