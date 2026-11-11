import type { LiveEvent, LiveSnapshot } from "./contracts";

export function emptyLive(now = new Date()): LiveSnapshot {
	return {
		packets: [],
		reportingNodes: 0,
		packetsLastMinute: 0,
		observerStartedAt: now,
		checkedAt: now,
		lastReceivedAt: null,
		status: "connecting",
		limited: false,
		received: 0,
	};
}

/**
 * Packets per minute over the last minute, or over the time observed so far when the
 * connection is younger, so the rate does not ramp up during the first minute.
 */
export function packetRate(arrivals: number[], startedAt: Date, now: Date) {
	const window = Math.min(
		60000,
		// A floor keeps the first few packets from reading as a huge spike.
		Math.max(10000, now.getTime() - startedAt.getTime()),
	);
	const count = arrivals.filter(
		(time) => time > now.getTime() - window && time <= now.getTime(),
	).length;
	return Math.round((count * 60000) / window);
}

export function liveSnapshot(
	events: LiveEvent[],
	startedAt: Date,
	now = new Date(),
	received = events.length,
	arrivals: number[] = events.map((e) => e.summary.receivedAt.getTime()),
): LiveSnapshot {
	const recent = events.filter(
		(e) => e.summary.receivedAt.getTime() >= now.getTime() - 60000,
	);
	const nodes = new Set<string>();
	for (const event of recent)
		for (const node of event.nodeTimes)
			if (
				node.time >= now.getTime() - 60000 &&
				node.time <= now.getTime() + 30000
			)
				nodes.add(node.id);
	return {
		packets: events.map((e) => e.summary),
		reportingNodes: nodes.size,
		packetsLastMinute: packetRate(arrivals, startedAt, now),
		observerStartedAt: startedAt,
		checkedAt: now,
		lastReceivedAt: events[0]?.summary.receivedAt ?? null,
		status: "connected",
		limited: events.length >= 100 || events.some((e) => e.limited),
		received,
	};
}

export function parseLiveEvent(
	value: string,
	expectedProject: string,
): LiveEvent {
	if (value.length > 65536) throw new Error("Live event exceeds byte bound");
	const event = JSON.parse(value) as LiveEvent;
	if (
		event.projectId !== expectedProject ||
		!event.summary ||
		!Array.isArray(event.summary.nodes) ||
		event.summary.nodes.length > 64 ||
		!Array.isArray(event.nodeTimes) ||
		event.nodeTimes.length > 64
	)
		throw new Error("Invalid Live event");
	event.summary.receivedAt = new Date(event.summary.receivedAt);
	event.summary.measuredAt = event.summary.measuredAt
		? new Date(event.summary.measuredAt)
		: null;
	if (!Number.isFinite(event.summary.receivedAt.getTime()))
		throw new Error("Invalid Live timestamp");
	return event;
}
