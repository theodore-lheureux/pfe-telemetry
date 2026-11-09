export interface AuthEmailDelivery {
	track: (task: Promise<unknown>) => void;
	send: (delivery: () => Promise<void>) => Promise<void>;
	drain: (timeoutMs?: number) => Promise<void>;
	close: () => Promise<void>;
	readonly closing: boolean;
}

export function createAuthEmailDelivery(
	onFailure: () => void = () =>
		console.error("Authentication email delivery failed"),
): AuthEmailDelivery {
	const pending = new Set<Promise<unknown>>();
	let closing = false;
	const report = () => {
		try {
			onFailure();
		} catch {
			/* Failure reporting must not expose the delivery payload. */
		}
	};
	const drain = async (timeoutMs = 30_000) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				(async () => {
					while (pending.size) await Promise.allSettled([...pending]);
				})(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new Error(
									"Authentication email delivery did not drain before shutdown",
								),
							),
						timeoutMs,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	};
	return {
		get closing() {
			return closing;
		},
		track(task) {
			const owned = task.catch(report).finally(() => pending.delete(owned));
			pending.add(owned);
		},
		send(delivery) {
			if (closing) {
				report();
				return Promise.resolve();
			}
			return Promise.resolve().then(delivery).catch(report);
		},
		drain,
		async close() {
			closing = true;
			await drain();
		},
	};
}

const runtime = process as typeof process & {
	recountAuthEmailDelivery?: AuthEmailDelivery;
};

export function processAuthEmailDelivery() {
	runtime.recountAuthEmailDelivery ??= createAuthEmailDelivery();
	return runtime.recountAuthEmailDelivery;
}

export async function drainProcessAuthEmailDelivery(closing = false) {
	const delivery = runtime.recountAuthEmailDelivery;
	if (!delivery) return;
	if (closing) {
		await delivery.close();
		if (runtime.recountAuthEmailDelivery === delivery)
			delete runtime.recountAuthEmailDelivery;
	} else await delivery.drain();
}
