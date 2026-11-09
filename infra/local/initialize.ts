import { checkData, command, compose, configuration, role } from "./data";

// One explicitly selected empty role; no retries, schema repair or checkpoint changes.
async function initialize() {
	const selected = role(process.argv[2]);
	if (process.argv.length !== 3)
		throw new Error("usage: initialize.ts postgres|kafka|clickhouse");
	const config = configuration();
	if (compose(["ps", "--status", "running", "--quiet", selected]))
		throw new Error("Stop the selected role before explicit initialization");
	checkData(config, [selected], "initialize");
	const name = `${config.name}-initialize-${selected}-${crypto.randomUUID()}`;
	let ready = false;
	let interrupted = false;
	let failure: unknown;
	let interruptCreation: (() => void) | undefined;
	const interrupt = () => {
		interrupted = true;
		try {
			interruptCreation?.();
		} catch {
			// A raced client exit must not bypass cleanup of the owned container.
		}
	};
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	try {
		const creation = Bun.spawn(
			[
				"docker",
				"compose",
				"run",
				"--detach",
				"--no-deps",
				"--use-aliases",
				"--name",
				name,
				"--env",
				`RECOUNT_INITIALIZE_ROLE=${selected}`,
				selected,
			],
			{ stdout: "ignore", stderr: "inherit", timeout: 120_000 },
		);
		interruptCreation = () => creation.kill("SIGTERM");
		const status = await creation.exited;
		interruptCreation = undefined;
		if (interrupted)
			throw new Error(
				"Initialization interrupted during creation; inspect partial state before retrying",
			);
		if (status !== 0)
			throw new Error(
				`Initialization creation failed (${status}); inspect partial state before retrying`,
			);
		const deadline = Date.now() + 180_000;
		while (Date.now() < deadline) {
			if (interrupted)
				throw new Error(
					"Initialization interrupted; inspect partial state before retrying",
				);
			const [{ State: state }] = JSON.parse(
				command(["docker", "container", "inspect", name]),
			);
			if (
				!state.Running ||
				state.OOMKilled ||
				state.Health?.Status === "unhealthy"
			)
				throw new Error(
					"Initialization failed; inspect the owned container and partial data before retrying",
				);
			if (state.Health?.Status === "healthy") {
				ready = true;
				break;
			}
			await Bun.sleep(500);
		}
		if (!ready)
			throw new Error(
				"Initialization readiness deadline exceeded; inspect partial state before retrying",
			);
	} catch (error) {
		failure = error;
	} finally {
		try {
			// Creation may have succeeded remotely even when the Compose client failed.
			const owned = Bun.spawnSync(["docker", "container", "inspect", name], {
				stdout: "ignore",
				stderr: "ignore",
				timeout: 10_000,
			});
			if (owned.success) command(["docker", "stop", "--time", "60", name]);
			else if (failure === undefined)
				failure = new Error(
					"Initialization container was not confirmed; inspect before retrying",
				);
		} catch (error) {
			if (failure === undefined) failure = error;
			else
				console.error(
					`Cleanup failed for owned initialization container ${name}; inspect before retrying`,
					error,
				);
		} finally {
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", interrupt);
		}
	}
	if (failure !== undefined) throw failure;
	if (interrupted)
		throw new Error(
			"Initialization interrupted; partial state requires inspection",
		);
	const identity = compose([
		"run",
		"--rm",
		"--no-deps",
		"--entrypoint",
		"/bin/sh",
		selected,
		"/etc/recount/data-entrypoint.sh",
		selected,
		"--identity",
	]);
	if (!identity || identity.includes("\n"))
		throw new Error("Initialization identity was not confirmed");
	command(["docker", "rm", name]);
	console.log(
		`Record in the selected ignored local configuration: RECOUNT_${selected.toUpperCase()}_DATA_ID=${identity}`,
	);
}

if (import.meta.main) await initialize();
