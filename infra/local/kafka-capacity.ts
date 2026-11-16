import { parseArgs } from "node:util";

export function effectiveSettings(text: string): Map<string, string> {
	const settings = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = /^\s*([\w.]+)=([^\s,]+)/.exec(line);
		if (match) settings.set(match[1], match[2]);
	}
	return settings;
}

export function offsets(
	text: string,
	topic: string,
	allowEmpty = false,
): Map<number, number> {
	const result = new Map<number, number>();
	for (const line of text.trim().split("\n")) {
		const [name, partition, offset] = line.trim().split(":");
		if (name === topic) result.set(Number(partition), Number(offset));
	}
	if (!result.size && !allowEmpty)
		throw new Error(`No watermarks for ${topic}`);
	return result;
}

export function checkpoints(text: string, topic: string): Map<number, number> {
	const result = new Map<number, number>();
	for (const line of text.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields[1] === topic && /^\d+$/.test(fields[2])) {
			const value = fields[3] === "-" ? Number.NaN : Number(fields[3]);
			result.set(Number(fields[2]), value);
		}
	}
	return result;
}

export function headroom(input: {
	low: number;
	high: number;
	saved?: number;
	bytes: number;
	byteLimit: number;
	guard: number;
}) {
	const { low, high, saved, bytes, byteLimit, guard } = input;
	if (
		![low, high, bytes, byteLimit, guard].every(Number.isSafeInteger) ||
		low < 0 ||
		high < low ||
		bytes < 0 ||
		byteLimit <= 0 ||
		guard < -1
	)
		throw new Error("Incomplete capacity snapshot");
	let state = "ok";
	if (saved !== undefined && !Number.isSafeInteger(saved))
		state = "checkpoint_missing";
	else if (saved !== undefined && (saved < low || saved > high))
		state = "retention_gap";
	else if (
		saved !== undefined &&
		saved < high &&
		(guard === -1 || saved < guard)
	)
		state = "time_headroom_low";
	else if (bytes >= byteLimit * 0.8) state = "byte_headroom_low";
	return {
		state,
		low,
		high,
		committed: saved,
		lag: saved === undefined ? undefined : high - saved,
		retainedPrefixRecords: saved === undefined ? undefined : saved - low,
		retainedBytes: bytes,
		byteHeadroom: byteLimit - bytes,
		retentionGap: Number(state === "retention_gap"),
	};
}

export function partitionMetrics(
	topic: string,
	group: string,
	partition: number,
	values: ReturnType<typeof headroom>,
): string {
	const labels = `topic="${topic}",group="${group}",partition="${partition}"`;
	const series = {
		retention_gap: values.retentionGap,
		checkpoint_missing: Number(values.state === "checkpoint_missing"),
		consumer_lag: values.lag,
		retained_prefix_records: values.retainedPrefixRecords,
		retained_log_bytes: values.retainedBytes,
		retention_byte_headroom: values.byteHeadroom,
	};
	return Object.entries(series)
		.filter(([, value]) => value !== undefined && Number.isFinite(value))
		.map(([name, value]) => `recount_kafka_${name}{${labels}} ${value}`)
		.join("\n");
}

async function command(container: string, args: string[]): Promise<string> {
	const child = Bun.spawn(["docker", "exec", container, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${stderr}`);
	return stdout;
}

async function snapshot(
	container: string,
	topic: string,
	group: string,
	warnMs: number,
) {
	const kafka = (tool: string, args: string[]) =>
		command(container, [
			`/opt/kafka/bin/kafka-${tool}.sh`,
			"--bootstrap-server",
			"localhost:9092",
			...args,
		]);
	const settings = effectiveSettings(
		await kafka("configs", [
			"--entity-type",
			"topics",
			"--entity-name",
			topic,
			"--describe",
			"--all",
		]),
	);
	const retentionMs = Number(settings.get("retention.ms"));
	const byteLimit = Number(settings.get("retention.bytes"));
	if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0)
		throw new Error(`${topic}: bounded positive retention.ms required`);
	const readOffsets = async (time: string, allowEmpty = false) =>
		offsets(
			await kafka("get-offsets", ["--topic", topic, "--time", time]),
			topic,
			allowEmpty,
		);
	const low = await readOffsets("earliest");
	const saved =
		group === "-"
			? new Map<number, number>()
			: checkpoints(
					await kafka("consumer-groups", [
						"--group",
						group,
						"--describe",
						"--offsets",
					]),
					topic,
				);
	// Read the end after checkpoints, so concurrent progress cannot look like a future offset.
	const high = await readOffsets("latest");
	const guard =
		group === "-"
			? new Map<number, number>()
			: await readOffsets(String(Date.now() - retentionMs + warnMs), true);
	const logs = await kafka("log-dirs", ["--describe", "--topic-list", topic]);
	const json = logs.slice(logs.indexOf('{"brokers"'));
	const directories: {
		brokers: {
			logDirs: {
				error: string | null;
				partitions: { partition: string; size: number }[];
			}[];
		}[];
	} = JSON.parse(json);
	const sizes = new Map<string, number>();
	for (const broker of directories.brokers) {
		for (const directory of broker.logDirs) {
			if (directory.error) throw new Error(directory.error);
			for (const partition of directory.partitions)
				sizes.set(partition.partition, partition.size);
		}
	}
	if (directories.brokers.length !== 1)
		throw new Error("This capacity check requires exactly one broker");
	const partitions = [...low].map(([partition, start]) => ({
		partition,
		...headroom({
			low: start,
			high: high.get(partition) ?? Number.NaN,
			saved: group === "-" ? undefined : (saved.get(partition) ?? Number.NaN),
			bytes: sizes.get(`${topic}-${partition}`) ?? Number.NaN,
			byteLimit,
			guard: guard.get(partition) ?? high.get(partition) ?? Number.NaN,
		}),
	}));
	return {
		sampledAt: new Date().toISOString(),
		topic,
		group,
		retentionMs,
		byteLimit,
		warnMs,
		partitions,
	};
}

async function main() {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			container: { type: "string" },
			"warn-ms": { type: "string", default: "3600000" },
			format: { type: "string", default: "json" },
		},
	});
	const container = values.container;
	const warnMs = Number(values["warn-ms"]);
	if (
		!container ||
		!/^[\w][\w.-]*$/.test(container) ||
		!positionals.length ||
		!Number.isSafeInteger(warnMs) ||
		warnMs <= 0 ||
		!["json", "prometheus"].includes(values.format ?? "")
	)
		throw new Error(
			"Usage: kafka-capacity.ts --container NAME [--warn-ms MS] [--format json|prometheus] TOPIC=GROUP ... (GROUP=- for best-effort live)",
		);
	let exit = 0;
	for (const pair of positionals) {
		const [topic, group, extra] = pair.split("=");
		if (
			extra !== undefined ||
			!topic ||
			!group ||
			!/^[\w.-]+$/.test(topic) ||
			!/^[\w.-]+$/.test(group)
		)
			throw new Error(`Invalid topic/group pair: ${pair}`);
		try {
			const result = await snapshot(container, topic, group, warnMs);
			if (values.format === "prometheus") {
				console.log(
					`recount_kafka_capacity_scrape_success{topic="${topic}",group="${group}"} 1`,
				);
				for (const partition of result.partitions)
					console.log(
						partitionMetrics(topic, group, partition.partition, partition),
					);
			} else {
				console.log(JSON.stringify(result));
			}
			for (const partition of result.partitions) {
				if (partition.state !== "ok") exit = Math.max(exit, 1);
			}
		} catch (error) {
			if (values.format === "prometheus") {
				console.log(
					`recount_kafka_capacity_scrape_success{topic="${topic}",group="${group}"} 0`,
				);
				console.error(`capacity_unknown: ${topic} ${group}: ${error}`);
			} else
				console.log(
					JSON.stringify({
						sampledAt: new Date().toISOString(),
						topic,
						group,
						state: "capacity_unknown",
						error: String(error),
					}),
				);
			exit = 2;
		}
	}
	const disk = await command(container, ["df", "-Pk", "/var/lib/kafka/data"]);
	const fields = disk.trim().split("\n").at(-1)?.trim().split(/\s+/);
	const availableBytes = Number(fields?.[3]) * 1024;
	const usedPercent = Number(fields?.[4]?.replace("%", ""));
	if (!Number.isSafeInteger(availableBytes) || !Number.isFinite(usedPercent))
		throw new Error("Missing filesystem capacity");
	if (values.format === "prometheus") {
		console.log(`recount_kafka_disk_available_bytes ${availableBytes}`);
		console.log(`recount_kafka_disk_used_percent ${usedPercent}`);
	} else
		console.log(JSON.stringify({ storage: { availableBytes, usedPercent } }));
	if (usedPercent >= 80) exit = Math.max(exit, 1);
	process.exitCode = exit;
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(`capacity_unknown: ${error.message}`);
		process.exitCode = 2;
	});
}
