import {
	appendFile,
	chmod,
	copyFile,
	mkdir,
	readFile,
	realpath,
	stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validateArtifacts } from "../../infra/local/artifacts";
import { stageWeb } from "../../tooling/stage-web";

if (import.meta.main) {
	const [arch, log] = process.argv.slice(2);
	if (!["amd64", "arm64"].includes(arch) || !log || process.argv.length !== 4)
		throw new Error(
			"Usage: bun tests/ci/stage-artifacts.ts ARCH <Cargo build JSON log>",
		);
	if (
		process.platform !== "linux" ||
		({ x64: "amd64", arm64: "arm64" } as Record<string, string>)[
			process.arch
		] !== arch
	)
		throw new Error(
			"CI web staging requires Linux dependencies matching the explicitly selected runtime architecture",
		);
	const executables = new Map<string, Set<string>>();
	for (const line of (await readFile(log, "utf8"))
		.split("\n")
		.filter(Boolean)) {
		const event = JSON.parse(line);
		if (
			event.reason !== "compiler-artifact" ||
			!event.executable ||
			event.profile.test
		)
			continue;
		const paths = executables.get(event.target.name) ?? new Set<string>();
		paths.add(await realpath(event.executable));
		executables.set(event.target.name, paths);
	}
	function executable(name: string) {
		const paths = [...(executables.get(name) ?? [])];
		if (paths.length !== 1)
			throw new Error(`Expected exactly one host-built ${name} executable`);
		return paths[0];
	}
	const artifacts = resolve(".state/artifacts", arch);
	await mkdir(dirname(artifacts), { recursive: true });
	await mkdir(artifacts);
	await mkdir(join(artifacts, "bin"));
	for (const role of ["collector", "ingestion-api", "normalizer"]) {
		const source = executable(`recount-${role}`);
		const target = join(artifacts, "bin", `recount-${role}`);
		await copyFile(source, target);
		await chmod(target, (await stat(source)).mode);
	}
	await stageWeb(join(artifacts, "web"));
	await validateArtifacts(arch, [
		"collector",
		"ingestion-api",
		"normalizer",
		"web",
	]);
	const fixture = executable("contract_fixture");
	if (process.env.GITHUB_ENV) {
		await appendFile(
			process.env.GITHUB_ENV,
			`RECOUNT_CONTRACT_FIXTURE=${fixture}\nRECOUNT_PIPELINE_BIN_DIRECTORY=${artifacts}/bin\n`,
		);
	} else console.log(`RECOUNT_CONTRACT_FIXTURE=${fixture}`);
}
