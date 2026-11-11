import { cp, mkdir } from "node:fs/promises";
import { validateWebRuntime } from "./artifact-policy";

export async function stageWeb(destination: string) {
	await mkdir(destination);
	validateWebRuntime("apps/web/.output");
	await cp("apps/web/.output", destination, {
		recursive: true,
		verbatimSymlinks: true,
	});
	validateWebRuntime(destination);
}
