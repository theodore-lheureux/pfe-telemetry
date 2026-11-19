import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor";

const [schema, capture, output] = process.argv.slice(2);
if (!schema || !capture || !output)
	throw new Error(
		"Usage: bun tooling/load/scrub.ts otlp.pb capture.pb fixture.json",
	);
const type = protobuf.Root.fromDescriptor(
	descriptor.FileDescriptorSet.decode(await Bun.file(schema).bytes()),
).lookupType(
	"opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
);

const input = type.toObject(type.decode(await Bun.file(capture).bytes()), {
	longs: String,
});
const safeValues: Record<string, RegExp> = {
	"os.type": /^linux$/,
	"recount.collection.source": /^rust-procfs$/,
	"recount.collection.scope": /^(node|process|collector)$/,
	"recount.collection.visibility": /^(host|restricted)$/,
	"recount.collection.interval_ns": /^1000000000$/,
	"recount.linux.clock_ticks_per_second": /^\d{1,4}$/,
	"cpu.mode": /^(user|nice|system|idle|interrupt|softirq|steal|wait)$/,
	"disk.io.direction": /^(read|write)$/,
	reason:
		/^(identity_unverified|disappeared|buffer_full|buffer_expired|permanent_rejection)$/,
};

const safeMetrics = new Set([
	"recount.collection.scan.duration",
	"recount.clock.status",
	"recount.node.cpu.time",
	"recount.node.memory.total",
	"recount.node.memory.available",
	"system.disk.io",
	"recount.collection.read.status",
	"process.cpu.time",
	"recount.process.memory.rss",
	"process.disk.io",
	"recount.collection.discovery.status",
	"recount.collection.discovered.processes",
	"recount.collection.discarded.processes",
	"recount.collection.dropped.points",
]);
const identities = new Map<string, Map<string, number>>();
function synthetic(key: string, value: string, offset = 1) {
	const values = identities.get(key) ?? new Map<string, number>();
	identities.set(key, values);
	if (!values.has(value)) values.set(value, values.size + offset);
	return values.get(value);
}

type Attribute = {
	key: string;
	value: { intValue?: string; stringValue?: string };
};
function scrub({ key, value }: Attribute): Attribute | undefined {
	const raw = value.stringValue ?? value.intValue ?? "";
	let stringValue: string;
	switch (key) {
		case "host.id":
		case "host.name":
		case "recount.host.boot_id":
		case "recount.collection.epoch_id":
		case "recount.process.namespace_id":
			stringValue = "fixture";
			break;
		case "recount.process.incarnation_id":
		case "recount.process.start_time_ticks": {
			const ticks = synthetic("ticks", raw.replace(/^start-ticks:/, ""), 100);
			stringValue = key.endsWith("incarnation_id")
				? `start-ticks:${ticks}`
				: String(ticks);
			break;
		}
		case "process.pid":
		case "process.parent_pid":
			return {
				key,
				value: { intValue: raw === "0" ? "0" : String(synthetic("pid", raw)) },
			};
		case "recount.counter.segment_id":
			stringValue = `segment-${synthetic(key, raw)}`;
			break;
		case "system.device":
			stringValue = `fixture-disk-${synthetic(key, raw)}`;
			break;
		default:
			if (
				!safeValues[key]?.test(raw) &&
				!(key === "recount.metric.name" && safeMetrics.has(raw))
			)
				return;
			return {
				key,
				value:
					value.intValue === undefined
						? { stringValue: raw }
						: { intValue: raw },
			};
	}
	return { key, value: { stringValue } };
}

type Point = {
	timeUnixNano: string;
	startTimeUnixNano?: string;
	asInt?: string;
	asDouble?: number;
	attributes?: Attribute[];
	flags?: number;
};
const attributes = (items: Attribute[] = []) =>
	items.map(scrub).filter((item) => item !== undefined);
let latest = 0n;
const points: Point[] = [];
const resourceMetrics = input.resourceMetrics.map(
	(resource: {
		resource: { attributes: Attribute[] };
		scopeMetrics: Array<{
			metrics: Array<{
				name: string;
				unit?: string;
				gauge?: { dataPoints: Point[] };
				sum?: {
					aggregationTemporality: number;
					isMonotonic: boolean;
					dataPoints: Point[];
				};
			}>;
		}>;
	}) => ({
		resource: { attributes: attributes(resource.resource.attributes) },
		scopeMetrics: resource.scopeMetrics.map(({ metrics }) => ({
			scope: { name: "recount.collector.procfs", version: "0.1.0" },
			metrics: metrics.map(({ name, unit, gauge, sum }) => {
				if (!safeMetrics.has(name) || (!gauge && !sum))
					throw new Error("Unreviewed metric in capture");
				if (unit && !/^[a-zA-Z0-9{}./_-]{1,24}$/.test(unit))
					throw new Error("Unreviewed metric unit");
				const dataPoints = (gauge ?? sum)?.dataPoints.map((raw) => {
					const { timeUnixNano, startTimeUnixNano, asInt, asDouble, flags } =
						raw;
					const point = {
						timeUnixNano,
						startTimeUnixNano,
						asInt,
						asDouble,
						flags,
						attributes: attributes(raw.attributes),
					};
					const time = BigInt(timeUnixNano);
					if (time > latest) latest = time;
					points.push(point);
					return point;
				});
				return {
					name,
					unit,
					...(sum
						? {
								sum: {
									dataPoints,
									aggregationTemporality: sum.aggregationTemporality,
									isMonotonic: sum.isMonotonic,
								},
							}
						: { gauge: { dataPoints } }),
				};
			}),
		})),
	}),
);
for (const point of points) {
	point.timeUnixNano = String(BigInt(point.timeUnixNano) - latest);
	if (point.startTimeUnixNano && point.startTimeUnixNano !== "0")
		point.startTimeUnixNano = String(BigInt(point.startTimeUnixNano) - latest);
	else delete point.startTimeUnixNano;
}
await Bun.write(output, `${JSON.stringify({ resourceMetrics })}\n`);
console.log(`${points.length} points`);
