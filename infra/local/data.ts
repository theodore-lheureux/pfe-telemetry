import { readdirSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export const roles = ["postgres", "kafka", "clickhouse"] as const;
export type Role = (typeof roles)[number];
export type Mode = "start" | "initialize" | "inspect";
export interface Mount {
	type: string;
	source: string;
	target: string;
	bind?: { create_host_path?: boolean };
}
export interface ComposeConfig {
	name: string;
	services: Record<
		string,
		{ volumes?: Mount[]; environment?: Record<string, string> }
	>;
	volumes: Record<string, { name: string }>;
}
const targets: Record<Role, string> = {
	postgres: "/var/lib/postgresql",
	kafka: "/var/lib/kafka/data",
	clickhouse: "/var/lib/clickhouse",
};
const markers: Record<Role, string[]> = {
	postgres: ["18/docker/PG_VERSION", "18/docker/global/pg_control"],
	kafka: ["meta.properties"],
	clickhouse: ["uuid", "metadata/telemetry/metric_points.sql"],
};

export function role(value: string | undefined): Role {
	if (!roles.includes(value as Role))
		throw new Error("Expected postgres, kafka or clickhouse");
	return value as Role;
}

export function command(args: string[]): string {
	const result = Bun.spawnSync(args, {
		stdout: "pipe",
		stderr: "inherit",
		timeout: 120_000,
	});
	if (!result.success)
		throw new Error(`${args[0]} ${args[1]} failed (${result.exitCode})`);
	return result.stdout.toString().trim();
}

export function compose(args: string[]): string {
	return command(["docker", "compose", ...args]);
}
export function configuration(): ComposeConfig {
	return JSON.parse(compose(["config", "--format", "json"]));
}

export function validateData(
	config: ComposeConfig,
	environment: NodeJS.ProcessEnv,
	selected: readonly Role[],
	mode: Mode,
): void {
	for (const service of selected) {
		const definition = config.services[service];
		const mounts =
			definition?.volumes?.filter(
				(mount) => mount.target === targets[service],
			) ?? [];
		if (mounts.length !== 1)
			throw new Error(`${service}: expected exactly one data mount`);
		const mount = mounts[0];
		const requested =
			environment[`RECOUNT_${service.toUpperCase()}_DATA_DIRECTORY`];
		if (requested && (mount.type !== "bind" || mount.source !== requested))
			throw new Error(
				`${service}: selected host data path is ignored; select data.binds.yaml`,
			);
		if (mode === "start" && !definition.environment?.RECOUNT_DATA_ID)
			throw new Error(`${service}: expected database identity required`);
		if (mount.type === "bind") {
			if (
				mount.bind?.create_host_path !== false ||
				!isAbsolute(mount.source) ||
				!statSync(mount.source).isDirectory()
			)
				throw new Error(
					`${service}: existing absolute bind directory required; automatic creation is forbidden`,
				);
			if (mode === "initialize") {
				if (readdirSync(mount.source).length)
					throw new Error(`${service}: initialization requires empty data`);
			} else {
				for (const marker of markers[service]) {
					const file = statSync(`${mount.source}/${marker}`);
					if (!file.isFile() || !file.size)
						throw new Error(
							`${service}: database content missing; refusing replacement initialization`,
						);
				}
			}
		} else if (mount.type !== "volume" || !config.volumes[mount.source]?.name)
			throw new Error(
				`${service}: expected a named volume or explicit existing bind`,
			);
	}
}

export function checkData(
	config: ComposeConfig,
	selected: readonly Role[],
	mode: Mode,
): void {
	validateData(config, process.env, selected, mode);
	for (const service of selected) {
		const mount = config.services[service].volumes?.find(
			(item) => item.target === targets[service],
		);
		if (mount?.type !== "volume") continue;
		const name = config.volumes[mount.source].name;
		const inspected = Bun.spawnSync(["docker", "volume", "inspect", name], {
			stdout: "ignore",
			stderr: "ignore",
			timeout: 10_000,
		});
		if (!inspected.success && mode !== "initialize")
			throw new Error(
				`${service}: named volume missing; initialization must be explicit`,
			);
		if (inspected.success && mode === "initialize") {
			command([
				"docker",
				"run",
				"--rm",
				"--network",
				"none",
				"--read-only",
				"--memory",
				"64m",
				"--pids-limit",
				"32",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--mount",
				`type=volume,src=${name},dst=/data,readonly`,
				"debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a",
				"sh",
				"-ec",
				'[ -z "$(find /data -mindepth 1 -maxdepth 1 -print -quit)" ]',
			]);
		}
	}
}

if (import.meta.main) {
	const [mode = "start", ...selected] = process.argv.slice(2);
	if (!["start", "initialize", "inspect"].includes(mode))
		throw new Error("Expected start, initialize or inspect");
	checkData(
		configuration(),
		selected.length ? selected.map(role) : roles,
		mode as Mode,
	);
}
