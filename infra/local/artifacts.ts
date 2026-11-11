import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	inside,
	validateElf,
	validateWebRuntime,
} from "../../tooling/artifact-policy";

export const services = [
	"collector",
	"ingestion-api",
	"normalizer",
	"web",
] as const;
export type Service = (typeof services)[number];

export async function validateArtifacts(
	arch: string,
	selected: readonly string[],
): Promise<void> {
	if (!["arm64", "amd64"].includes(arch))
		throw new Error("Expected target arch arm64 or amd64");
	const root = realpathSync(resolve(import.meta.dir, "../../.state/artifacts"));
	const artifacts = realpathSync(join(root, arch));
	if (!inside(root, artifacts))
		throw new Error("Artifact directory must be inside .state/artifacts");
	for (const service of selected) {
		if (!services.includes(service as Service))
			throw new Error(`Unknown service ${service}`);
		if (service === "web") {
			const web = realpathSync(join(artifacts, "web"));
			if (!inside(artifacts, web))
				throw new Error("Web staging directory escapes selected artifacts");
			validateWebRuntime(web);
		} else {
			const path = join(artifacts, "bin", `recount-${service}`);
			if (!inside(artifacts, realpathSync(path)))
				throw new Error("Binary escapes selected artifacts");
			validateElf(
				new Uint8Array(await Bun.file(path).slice(0, 20).arrayBuffer()),
				statSync(path).mode,
				arch,
			);
		}
	}
}

if (import.meta.main) {
	const [arch, ...selected] = process.argv.slice(2);
	if (!arch) throw new Error("usage: artifacts.ts ARCH [SERVICE...]");
	await validateArtifacts(arch, selected.length ? selected : services);
}
