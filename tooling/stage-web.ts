import { cp, mkdir } from "node:fs/promises";
import { validateWebRuntime } from "./artifact-policy";

export async function stageWeb(
	destination: string,
	source = "apps/web/.output",
) {
	await mkdir(destination);
	validateWebRuntime(source);
	await cp(source, destination, {
		recursive: true,
		verbatimSymlinks: true,
	});
	validateWebRuntime(destination);
}
