export function ownLiveConnection(
	signal: AbortSignal,
	start: (stopped: () => boolean) => Promise<void>,
	dispose: () => Promise<void>,
) {
	let stopped = signal.aborted;
	let reject: (error: Error) => void = () => {};
	const cancelled = new Promise<never>((_, fail) => {
		reject = fail;
	});
	const startup = Promise.resolve().then(() => {
		if (stopped) throw new Error("Live connection cancelled");
		return start(() => stopped);
	});
	let closing: Promise<void> | undefined;
	const close = () => {
		stopped = true;
		reject(new Error("Live connection cancelled"));
		signal.removeEventListener("abort", abort);
		// KafkaJS has no cancellable run(): late startup is still owned and disposed.
		closing ??= startup.catch(() => {}).then(dispose);
		return closing;
	};
	const abort = () => {
		void close().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	if (stopped) abort();
	const ready = Promise.race([startup, cancelled]);
	void ready.catch(() => {});
	return { ready, close };
}
