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

export function gatewayRequest(path: string, params: Record<string, string>) {
	const base = process.env.RECOUNT_LIVE_GATEWAY_URL;
	const secret = process.env.RECOUNT_LIVE_GATEWAY_SECRET;
	if (!base || !secret || secret.length < 32)
		throw new OperationError("UNAVAILABLE", "Live is not configured");
	const url = new URL(path, base);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new OperationError("UNAVAILABLE", "Invalid Live gateway URL");
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
