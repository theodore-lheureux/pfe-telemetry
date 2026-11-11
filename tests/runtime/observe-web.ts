import type { AuthEmailDelivery } from "../../apps/web/src/auth/email-delivery.server";
import type { createDatabase } from "../../apps/web/src/db/client.server";
import { gate } from "../../apps/web/tests/gate";

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
let sentDraining = false;

// Keep the process alive after Nitro closes, so process exit cannot hide leaked resources.
const observer = setInterval(() => {
	pool ??= runtime.recountApplicationDatabase?.pool;
	delivery ??= authProcess.recountAuthEmailDelivery;
	if (!sentDraining && delivery?.closing && !pool?.ended) {
		sentDraining = true;
		process.send?.({ type: "draining-email" });
	}
	if (!sentClosed && pool?.ended && delivery?.closing) {
		sentClosed = true;
		process.send?.({ type: "closed", totalCount: pool.totalCount });
	}
}, 10);
process.on("message", (message: { type: string }) => {
	if (message.type === "hold-email") {
		if (!delivery || !pool?.totalCount)
			throw new Error("Actual SSR resources were not observed");
		const pending = gate();
		release = pending.release;
		delivery.track(pending.promise);
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
