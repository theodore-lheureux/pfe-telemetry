/**
 * Runs at most `limit` tasks at once, starting the others in the order they were
 * queued. A task whose signal aborts while it waits leaves the queue.
 */
export function taskQueue(limit: number) {
	let running = 0;
	const waiting: (() => void)[] = [];
	const next = () => {
		if (running < limit) waiting.shift()?.();
	};
	return async function run<T>(
		task: () => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		await new Promise<void>((resolve, reject) => {
			if (signal?.aborted) return reject(signal.reason);
			const start = () => {
				signal?.removeEventListener("abort", cancel);
				running++;
				resolve();
			};
			const cancel = () => {
				const index = waiting.indexOf(start);
				if (index >= 0) waiting.splice(index, 1);
				reject(signal?.reason);
			};
			waiting.push(start);
			signal?.addEventListener("abort", cancel, { once: true });
			next();
		});
		try {
			return await task();
		} finally {
			running--;
			next();
		}
	};
}
