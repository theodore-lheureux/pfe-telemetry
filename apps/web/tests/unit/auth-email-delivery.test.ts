import { expect, test } from "bun:test";
import {
	createAuthEmailDelivery,
	drainProcessAuthEmailDelivery,
	processAuthEmailDelivery,
} from "../../src/auth/email-delivery.server";
import { gate as createGate } from "../gate";

test("email tasks stay owned after dispatch and drain waits for completion", async () => {
	const { promise: gate, release } = createGate();
	let completed = false;
	const delivery = createAuthEmailDelivery();
	delivery.track(
		delivery.send(async () => {
			await gate;
			completed = true;
		}),
	);
	let drained = false;
	const draining = delivery.drain().then(() => {
		drained = true;
	});
	await Promise.resolve();
	expect(drained).toBe(false);
	release();
	await draining;
	expect(completed).toBe(true);
});
test("delivery failures are handled without exposing payloads and shutdown is bounded", async () => {
	let reports = 0;
	const delivery = createAuthEmailDelivery(() => {
		reports++;
	});
	delivery.track(
		delivery.send(async () => {
			throw new Error("private SMTP payload");
		}),
	);
	await delivery.drain();
	expect(reports).toBe(1);
	const { promise: gate, release } = createGate();
	delivery.track(gate);
	await expect(delivery.drain(5)).rejects.toThrow(
		"did not drain before shutdown",
	);
	release();
	await delivery.close();
	expect(delivery.closing).toBe(true);
});
test("source and bundled host integration share one process-owned registry", async () => {
	const first = processAuthEmailDelivery();
	const second = processAuthEmailDelivery();
	expect(first).toBe(second);
	const { promise: gate, release } = createGate();
	first.track(gate);
	let closed = false;
	const closing = drainProcessAuthEmailDelivery(true).then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	release();
	await closing;
	expect(processAuthEmailDelivery()).not.toBe(first);
	await drainProcessAuthEmailDelivery(true);
});
