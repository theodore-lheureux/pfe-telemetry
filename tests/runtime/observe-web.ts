import type { AuthEmailDelivery } from "../../apps/web/src/auth/email-delivery.server";
import type { createDatabase } from "../../apps/web/src/db/client.server";

const runtime = globalThis as typeof globalThis & {
	recountApplicationDatabase?: ReturnType<typeof createDatabase>;
};
const authProcess = process as typeof process & {
	recountAuthEmailDelivery?: AuthEmailDelivery;
};
let pool: ReturnType<typeof createDatabase>["pool"] | undefined;
let delivery: AuthEmailDelivery | undefined;
let release: (() => void) | undefined;
let sentClosed = false;

const telemetryModule = await import(
	new URL(
		"../../apps/web/.output/server/_libs/clickhouse__client.mjs",
		import.meta.url,
	).href
);
const telemetry = telemetryModule.require_dist();
const createTelemetry = telemetry.createClient;
Object.defineProperty(telemetry, "createClient", {
	value: (...args: unknown[]) => {
		const client = createTelemetry(...args);
		const close = client.close.bind(client);
		client.close = async () => {
			await close();
			process.send?.({ type: "telemetry-closed" });
		};
		return client;
	},
});

// Keep the process alive after Nitro closes, so process exit cannot hide leaked resources.
const observer = setInterval(() => {
	pool ??= runtime.recountApplicationDatabase?.pool;
	delivery ??= authProcess.recountAuthEmailDelivery;
	if (!sentClosed && pool?.ended && delivery?.closing) {
		sentClosed = true;
		process.send?.({ type: "closed", totalCount: pool.totalCount });
	}
}, 10);
process.on("message", (message: { type: string }) => {
	if (message.type === "hold-email") {
		if (!delivery || !pool?.totalCount)
			throw new Error("Actual SSR resources were not observed");
		delivery.track(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		process.send?.({ type: "holding-email", totalCount: pool.totalCount });
	} else if (message.type === "release-email") {
		process.send?.({
			type: "email-closing",
			closing: delivery?.closing,
			poolEnded: pool?.ended,
		});
		release?.();
	} else if (message.type === "finish") {
		clearInterval(observer);
		process.disconnect?.();
	}
});
