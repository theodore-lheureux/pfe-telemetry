const encoder = new TextEncoder();
export const sseHeaders = {
	"Content-Type": "text/event-stream; charset=utf-8",
	"Cache-Control": "private, no-store, no-transform",
	"X-Accel-Buffering": "no",
};

export async function* sseFrames(
	reader: ReadableStreamDefaultReader<Uint8Array>,
) {
	const decoder = new TextDecoder();
	let pending = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) return;
		if (chunk.value.byteLength > 131072)
			throw new Error("Live chunk exceeds byte bound");
		pending += decoder.decode(chunk.value, { stream: true });
		let end = pending.indexOf("\n\n");
		while (end >= 0) {
			if (end > 65534) throw new Error("Live frame exceeds byte bound");
			const frame = encoder.encode(pending.slice(0, end + 2));
			if (frame.byteLength > 65536)
				throw new Error("Live frame exceeds byte bound");
			pending = pending.slice(end + 2);
			yield frame;
			end = pending.indexOf("\n\n");
		}
		if (pending.length > 65536)
			throw new Error("Live frame exceeds byte bound");
	}
}

export function sseChannel(signal: AbortSignal, disposed: () => void) {
	let controller: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		signal.removeEventListener("abort", close);
		controller.close();
		disposed();
	};
	const body = new ReadableStream<Uint8Array>(
		{
			start(value) {
				controller = value;
			},
			cancel() {
				if (closed) return;
				closed = true;
				signal.removeEventListener("abort", close);
				disposed();
			},
		},
		{ highWaterMark: 65536, size: (chunk) => chunk?.byteLength ?? 0 },
	);
	const send = (event: string, data: unknown) => {
		if (closed) return false;
		const chunk = encoder.encode(
			`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
		);
		if ((controller.desiredSize ?? 0) < chunk.byteLength) {
			close();
			return false;
		}
		controller.enqueue(chunk);
		return true;
	};
	signal.addEventListener("abort", close, { once: true });
	if (signal.aborted) close();
	return {
		body,
		send,
		close,
		get closed() {
			return closed;
		},
	};
}
