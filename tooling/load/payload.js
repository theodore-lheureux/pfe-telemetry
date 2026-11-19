export function preparePayload(fixture, node) {
	const body = JSON.parse(JSON.stringify(fixture));
	const identities = {
		"host.id": node.machineId,
		"host.name": node.machineId,
		"recount.host.boot_id": node.boot,
		"recount.collection.epoch_id": node.epoch,
		"recount.process.namespace_id": `${node.machineId}-pid`,
	};
	const points = [];
	for (const resource of body.resourceMetrics) {
		for (const attr of resource.resource.attributes) {
			if (Object.hasOwn(identities, attr.key))
				attr.value.stringValue = identities[attr.key];
		}
		for (const scope of resource.scopeMetrics)
			for (const metric of scope.metrics)
				for (const point of (metric.sum ?? metric.gauge).dataPoints)
					points.push({
						point,
						time: BigInt(point.timeUnixNano),
						start: point.startTimeUnixNano && BigInt(point.startTimeUnixNano),
						counter: metric.sum?.isMonotonic
							? (point.asInt ?? point.asDouble)
							: undefined,
					});
	}
	return {
		count: points.length,
		at(now, started) {
			const wall = BigInt(now) * 1_000_000n;
			const epoch = BigInt(started) * 1_000_000n;
			const elapsed = Math.max(0, Math.floor((now - started) / 1000));
			for (const { point, time, start, counter } of points) {
				point.timeUnixNano = String(wall + time);
				if (start !== undefined)
					point.startTimeUnixNano = String(epoch + start);
				if (typeof counter === "string") {
					const value = BigInt(counter);
					point.asInt = String(
						value + (value > 0n ? 1n : 0n) * BigInt(elapsed),
					);
				} else if (typeof counter === "number") {
					point.asDouble = counter + (counter > 0 ? elapsed * 0.001 : 0);
				}
			}
			return body;
		},
	};
}
