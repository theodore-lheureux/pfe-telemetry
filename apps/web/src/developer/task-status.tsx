import { m } from "@recount/i18n/messages";
import { CheckIcon, CircleIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { Badge } from "../components/ui/badge";
import type { TaskStatus as Status } from "./contracts";

export function TaskStatus({ status }: { status: Status }) {
	const labels: Record<Status, string> = {
		waiting: m.developer_status_waiting(),
		starting: m.developer_status_starting(),
		waiting_confirmation: m.developer_status_waiting_confirmation(),
		confirmed: m.developer_status_confirmed(),
		rejected: m.developer_status_rejected(),
		running: m.developer_status_running(),
		stopping: m.developer_status_stopping(),
		stopped: m.developer_status_stopped(),
		success: m.developer_status_success(),
		error: m.developer_status_error(),
	};
	let Icon = CircleIcon;
	let variant: "secondary" | "destructive" | "outline" = "secondary";
	let iconClass = "size-3";
	if (["starting", "running", "stopping"].includes(status)) {
		Icon = LoaderCircleIcon;
		iconClass = "size-3 motion-safe:animate-spin";
	}
	if (status === "success") {
		Icon = CheckIcon;
		variant = "outline";
	}
	if (status === "error" || status === "rejected") {
		Icon = XIcon;
		variant = "destructive";
	}
	return (
		<Badge
			variant={variant}
			className="h-5 gap-1 text-[10px]"
			title={m.developer_status({ status })}
		>
			<Icon className={iconClass} aria-hidden="true" />
			{labels[status]}
		</Badge>
	);
}
