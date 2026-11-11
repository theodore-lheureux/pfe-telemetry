import { getAuth } from "../auth/auth.server";
import { applicationSession } from "../auth/session.server";
import { getDatabase } from "../db/client.server";
import { OperationError } from "../lib/operation-error";
import { parseProjectReference } from "../organizations/validation";
import { authorizeLive } from "./activity.server";
import { gatewayRequest, liveStreamControllers } from "./live.server";
import { sseFrames, sseHeaders } from "./sse.server";

const encoder = new TextEncoder();
const active = liveStreamControllers();
function failure(error: unknown) {
	const code = error instanceof OperationError ? error.code : "UNAVAILABLE";
	return encoder.encode(
		`event: failure\ndata: ${JSON.stringify({ code })}\n\n`,
	);
}

export async function activityStream(
	request: Request,
	authorize?: () => Promise<unknown>,
	open?: (signal: AbortSignal) => Promise<Response>,
	now = Date.now,
) {
	const url = new URL(request.url);
	const controller = new AbortController();
	const signal = AbortSignal.any([request.signal, controller.signal]);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		controller.abort();
		active.delete(controller);
		void reader?.cancel().catch(() => {});
		try {
			outputController?.close();
		} catch {}
	};
	const check =
		authorize ??
		(async () => {
			const reference = parseProjectReference(
				Object.fromEntries(url.searchParams),
			);
			const session = await applicationSession(getAuth(), request.headers);
			await authorizeLive(getDatabase(), session.user, reference);
		});
	try {
		if (active.size >= 512)
			throw new OperationError("CAPACITY", "Live connections are busy");
		active.add(controller);
		const origin = request.headers.get("origin");
		if (
			(origin && origin !== url.origin) ||
			request.headers.get("sec-fetch-site") === "cross-site"
		)
			throw new OperationError(
				"FORBIDDEN",
				"Cross-origin Live connection denied",
			);
		await check();
		const response = await (
			open ??
			((signal) => {
				const upstream = gatewayRequest("/stream", {
					projectId: url.searchParams.get("projectId") ?? "",
				});
				return fetch(upstream.url, { headers: upstream.headers, signal });
			})
		)(signal);
		if (!response.ok || !response.body)
			throw new OperationError("UNAVAILABLE", "Live unavailable");
		reader = response.body.getReader();
		const frames = sseFrames(reader);
		let checkedAt = now();
		const body = new ReadableStream<Uint8Array>(
			{
				start(output) {
					outputController = output;
					if (disposed) output.close();
				},
				async pull(output) {
					try {
						const chunk = await frames.next();
						if (disposed) return;
						if (!chunk || chunk.done) {
							output.close();
							dispose();
							return;
						}
						// Gateway heartbeats make idle streams reauthorize too.
						if (now() - checkedAt >= 10000) {
							await check();
							checkedAt = now();
						}
						if (chunk.value.byteLength > 65536)
							throw new OperationError("CAPACITY", "Live client is too slow");
						output.enqueue(chunk.value);
					} catch (error) {
						if (disposed) return;
						output.enqueue(failure(error));
						output.close();
						dispose();
					}
				},
				cancel() {
					outputController = undefined;
					dispose();
				},
			},
			{ highWaterMark: 65536, size: (chunk) => chunk?.byteLength ?? 0 },
		);
		signal.addEventListener("abort", dispose, { once: true });
		return new Response(body, { headers: sseHeaders });
	} catch (error) {
		dispose();
		return new Response(failure(error), { headers: sseHeaders });
	}
}
