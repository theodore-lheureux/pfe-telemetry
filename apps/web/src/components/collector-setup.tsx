import { m } from "@pfe/i18n/messages";
import {
	collectorBuildCommand,
	collectorRunCommand,
	collectorTokenCommand,
} from "../credentials/setup";

export function CollectorSetup() {
	return (
		<section
			className="flex flex-col gap-4 rounded-lg border p-5"
			aria-labelledby="collector-setup-title"
		>
			<h2 id="collector-setup-title" className="font-semibold">
				{m.run_a_linux_collector()}
			</h2>
			<ol className="flex list-decimal flex-col gap-5 pl-5 text-sm">
				<li>
					<p>{m.setup_build({ directory: "~/.local/bin" })}</p>
					<Command>{collectorBuildCommand}</Command>
				</li>
				<li>
					<p>{m.in_bash_save_the_onetime_token_to_a()}</p>
					<Command>{collectorTokenCommand}</Command>
					<p className="mt-2 text-muted-foreground">
						{m.setup_no_trace({ command: "set -x" })}
					</p>
				</li>
				<li>
					<p>{m.replace_the_host_id_with_an_exact_allowed()}</p>
					<Command>{collectorRunCommand}</Command>
					<p className="mt-2 text-muted-foreground">
						{m.setup_endpoint({ visibility: "restricted" })}
					</p>
				</li>
			</ol>
			<h3 className="font-medium">{m.planned_rotation()}</h3>
			<ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
				<li>{m.setup_drain({ command: "pfe-collector --drain" })}</li>
				<li>{m.confirm_rotation_then_save_the_replacement_token_to()}</li>
				<li>{m.choose_a_new_private_queue_directory_retain_the()}</li>
			</ol>
			<p className="text-sm text-muted-foreground">
				{m.setup_environment({
					endpoint: "OTEL_EXPORTER_OTLP_ENDPOINT",
					token: "TELEMETRY_COLLECTOR_SOURCE_TOKEN_FILE",
					host: "TELEMETRY_COLLECTOR_HOST_ID",
					namespace: "TELEMETRY_COLLECTOR_PROCESS_NAMESPACE_ID",
					visibility: "TELEMETRY_COLLECTOR_VISIBILITY",
					queue: "TELEMETRY_COLLECTOR_QUEUE_DIRECTORY",
				})}
			</p>
		</section>
	);
}

function Command({ children }: { children: string }) {
	return (
		<pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-xs">
			<code>{children}</code>
		</pre>
	);
}
