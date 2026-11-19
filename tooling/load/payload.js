function randomFor(seed) {
	let state = 2166136261;
	for (const char of String(seed))
		state = Math.imul(state ^ char.charCodeAt(0), 16777619);
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let bits = Math.imul(state ^ (state >>> 15), state | 1);
		bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
		return ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
	};
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const MAX_INT64 = (1n << 63n) - 1n;

function gaugeWalk(metric, point, random, memoryTotal) {
	const field = point.asInt === undefined ? "asDouble" : "asInt";
	const center = Number(point[field]);
	// Keep status codes, fixed capacity and unsafe JS integers as captured.
	if (
		!Number.isFinite(center) ||
		(field === "asInt" && !Number.isSafeInteger(center)) ||
		metric.name.endsWith(".status") ||
		metric.name.endsWith(".memory.total")
	)
		return;
	const integer = field === "asInt";
	const percent = metric.unit === "%";
	const fraction = metric.unit === "1" && metric.name.endsWith(".utilization");
	const radius = Math.max(
		integer ? 1 : 0.0001,
		Math.abs(center) * 0.1,
		fraction ? 0.035 : 0,
		percent ? 3.5 : 0,
	);
	const low = Math.max(
		center >= 0 || percent || fraction ? 0 : -Infinity,
		center - radius,
	);
	let cap = integer ? Number.MAX_SAFE_INTEGER : Infinity;
	if (fraction || percent) cap = fraction ? 1 : 100;
	else if (metric.name === "recount.node.memory.available") cap = memoryTotal;
	const high = Math.min(cap, center + radius);
	let value = clamp(center + (random() * 2 - 1) * radius, low, high);
	return () => {
		value = clamp(value + (random() * 2 - 1) * radius * 0.35, low, high);
		point[field] = integer ? String(Math.round(value)) : value;
	};
}

function counterWalk(metric, point, random) {
	if (!metric.sum?.isMonotonic || metric.sum.aggregationTemporality !== 2)
		return;
	if (point.asInt !== undefined) {
		let value = BigInt(point.asInt);
		if (value <= 0n) return;
		const rate = metric.unit === "By" ? 64 + random() * 4032 : 1 + random() * 3;
		return (cycles) => {
			if (!cycles) return;
			value += BigInt(Math.floor(rate * (0.2 + random() * 1.6) * cycles));
			if (value > MAX_INT64) value = MAX_INT64;
			point.asInt = String(value);
		};
	}
	let value = point.asDouble;
	if (!(value > 0)) return;
	const rate = 0.001 + random() * 0.049;
	return (cycles) => {
		if (!cycles) return;
		value += rate * (0.2 + random() * 1.6) * cycles;
		point.asDouble = value;
	};
}

export function preparePayload(fixture, node) {
	const body = JSON.parse(JSON.stringify(fixture));
	const random = randomFor(node.seed ?? node.machineId);
	const identities = {
		"host.id": node.machineId,
		"host.name": node.machineId,
		"recount.host.boot_id": node.boot,
		"recount.collection.epoch_id": node.epoch,
		"recount.process.namespace_id": `${node.machineId}-pid`,
	};
	const points = [];
	let previousCycle = -1;
	for (const resource of body.resourceMetrics) {
		for (const attr of resource.resource.attributes) {
			if (Object.hasOwn(identities, attr.key))
				attr.value.stringValue = identities[attr.key];
		}
		const metrics = resource.scopeMetrics.flatMap((scope) => scope.metrics);
		const capacity = metrics.find(
			(metric) => metric.name === "recount.node.memory.total",
		)?.gauge?.dataPoints[0];
		const memoryTotal = capacity
			? Number(capacity.asInt ?? capacity.asDouble)
			: Infinity;
		for (const metric of metrics) {
			// Distribution values travel together unchanged, including bucket counts, count and sum.
			const data =
				metric.sum ??
				metric.gauge ??
				metric.histogram ??
				metric.exponentialHistogram ??
				metric.summary;
			for (const point of data.dataPoints)
				points.push({
					point,
					time: BigInt(point.timeUnixNano),
					start: point.startTimeUnixNano && BigInt(point.startTimeUnixNano),
					vary: metric.gauge
						? gaugeWalk(metric, point, random, memoryTotal)
						: counterWalk(metric, point, random),
				});
		}
	}
	return {
		count: points.length,
		at(now, started, cycle) {
			const wall = BigInt(now) * 1_000_000n;
			const epoch = BigInt(started) * 1_000_000n;
			const nextCycle = cycle > previousCycle;
			const elapsed = cycle - Math.max(0, previousCycle);
			for (const { point, time, start, vary } of points) {
				point.timeUnixNano = String(wall + time);
				if (start !== undefined)
					point.startTimeUnixNano = String(epoch + start);
				if (nextCycle) vary?.(elapsed);
			}
			if (nextCycle) previousCycle = cycle;
			return body;
		},
	};
}
