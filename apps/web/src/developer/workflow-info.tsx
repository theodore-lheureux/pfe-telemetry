import { m } from "@recount/i18n/messages";
import { CpuIcon, GpuIcon } from "lucide-react";
import type { WorkflowAction } from "./contracts";

export function WorkflowInfo({ action }: { action: WorkflowAction }) {
	if (action !== "create-cpu" && action !== "create-gpu") return null;
	const information = {
		"create-cpu": {
			icon: CpuIcon,
			title: "t4g.nano",
			description: m.developer_cpu_details(),
		},
		"create-gpu": {
			icon: GpuIcon,
			title: "g2-standard-4",
			description: m.developer_gpu_details(),
		},
	}[action];
	const Icon = information.icon;
	return (
		<div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
			<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-primary">
				<Icon className="size-4" aria-hidden="true" />
			</div>
			<div className="min-w-0 space-y-0.5">
				<p className="text-xs font-medium">{information.title}</p>
				<p className="text-xs leading-relaxed text-muted-foreground">
					{information.description}
				</p>
			</div>
		</div>
	);
}
