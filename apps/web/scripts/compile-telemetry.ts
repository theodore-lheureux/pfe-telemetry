import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor";

export async function compileTelemetrySchema() {
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	const output = `${root}apps/web/src/activity/generated/descriptors.json`;
	const inputs = [
		"Cargo.lock",
		"crates/telemetry-schema/Cargo.toml",
		"crates/telemetry-schema/build.rs",
		"crates/telemetry-schema/proto/recount.proto",
		"crates/telemetry-schema/examples/recount-web-schema-export.rs",
		"apps/web/scripts/compile-telemetry.ts",
	];
	const hash = createHash("sha256");
	for (const input of inputs) hash.update(await readFile(root + input));
	const fingerprint = hash.digest("hex");
	try {
		if (JSON.parse(await readFile(output, "utf8")).fingerprint === fingerprint)
			return;
	} catch {}
	const metadata = Bun.spawnSync(
		["cargo", "metadata", "--no-deps", "--format-version", "1"],
		{ cwd: root, stdout: "pipe", stderr: "inherit" },
	);
	if (
		!metadata.success ||
		!JSON.parse(metadata.stdout.toString()).target_directory
	)
		throw new Error("Cargo build output discovery failed");
	const directory = `${root}.state/web-schema`;
	const built = Bun.spawnSync(
		[
			"cargo",
			"run",
			"--locked",
			"--quiet",
			"-p",
			"recount-telemetry-schema",
			"--example",
			"recount-web-schema-export",
			"--",
			directory,
		],
		{ cwd: root, stdout: "inherit", stderr: "inherit" },
	);
	if (!built.success) throw new Error("Telemetry descriptor generation failed");
	const files = [];
	for (const name of ["recount", "otlp"])
		files.push(
			...descriptor.FileDescriptorSet.decode(
				await readFile(`${directory}/${name}.pb`),
			).file,
		);
	const schema = protobuf.Root.fromDescriptor(
		{ file: files },
		{ keepCase: true },
	).toJSON();
	await mkdir(
		fileURLToPath(new URL("../src/activity/generated/", import.meta.url)),
		{ recursive: true },
	);
	await writeFile(output, `${JSON.stringify({ fingerprint, schema })}\n`);
}

if (import.meta.main) await compileTelemetrySchema();
