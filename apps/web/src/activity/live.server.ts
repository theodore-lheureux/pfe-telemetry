import * as z from "zod";
import { httpUrl, secret } from "../lib/env.server";
import { OperationError } from "../lib/operation-error";
import type { PacketDetail, PacketInput } from "./contracts";

const processState = globalThis as typeof globalThis & {
	__recountLiveStreams?: Set<AbortController>;
};
export function liveStreamControllers() {
	processState.__recountLiveStreams ??= new Set<AbortController>();
	return processState.__recountLiveStreams;
}
export async function closeLiveStreams() {
	for (const controller of liveStreamControllers()) controller.abort();
	liveStreamControllers().clear();
}

const settings = z.object({
	RECOUNT_LIVE_GATEWAY_URL: httpUrl("RECOUNT_LIVE_GATEWAY_URL"),
	RECOUNT_LIVE_GATEWAY_SECRET: secret("RECOUNT_LIVE_GATEWAY_SECRET"),
});

export function gatewayRequest(path: string, params: Record<string, string>) {
	// Live is optional: without it, Activity reports it as unavailable.
	const parsed = settings.safeParse(process.env);
	if (!parsed.success)
		throw new OperationError("UNAVAILABLE", "Live is not configured");
	const {
		RECOUNT_LIVE_GATEWAY_URL: base,
		RECOUNT_LIVE_GATEWAY_SECRET: secret,
	} = parsed.data;
	const url = new URL(path, base);
	url.search = new URLSearchParams(params).toString();
	return { url, headers: { Authorization: `Bearer ${secret}` } };
}

export async function livePacket(
	input: PacketInput,
	signal?: AbortSignal,
): Promise<PacketDetail> {
	const request = gatewayRequest("/packet", {
		projectId: input.projectId,
		packetId: input.packetId,
		partition: String(input.partition),
		offset: input.offset,
	});
	const response = await fetch(request.url, {
		headers: request.headers,
		signal: AbortSignal.any([
			...(signal ? [signal] : []),
			AbortSignal.timeout(15000),
		]),
	});
	if (!response.ok)
		throw new OperationError(
			response.status === 404 ? "NOT_FOUND" : "UNAVAILABLE",
			"Packet unavailable",
		);
	const detail = (await response.json()) as PacketDetail;
	detail.summary.receivedAt = new Date(detail.summary.receivedAt);
	detail.summary.measuredAt = detail.summary.measuredAt
		? new Date(detail.summary.measuredAt)
		: null;
	return detail;
}
