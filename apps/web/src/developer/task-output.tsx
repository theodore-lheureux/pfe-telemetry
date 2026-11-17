import { m } from "@recount/i18n/messages";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { Button } from "../components/ui/button";
import type { TaskSummary } from "./contracts";
import { TaskStatus } from "./task-status";

const TaskLogViewer = lazy(() => import("./task-log-viewer"));
export function TaskOutput({
	taskId,
	task,
	text,
	loading,
	error,
	onBack,
}: {
	taskId: number;
	task?: TaskSummary;
	text?: string;
	loading: boolean;
	error: boolean;
	onBack: () => void;
}) {
	return (
		<section aria-label={m.developer_logs()} className="min-w-0 space-y-3">
			<div className="flex items-center justify-between gap-2">
				<Button variant="ghost" size="xs" onClick={onBack}>
					<ArrowLeftIcon aria-hidden="true" />
					{m.developer_back_tasks()}
				</Button>
				{task?.nativeUrl && (
					<Button variant="ghost" size="xs" asChild>
						<a href={task.nativeUrl} target="_blank" rel="noreferrer">
							{m.developer_native_task()}
							<ExternalLinkIcon aria-hidden="true" />
						</a>
					</Button>
				)}
			</div>
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-xs font-medium">
					{m.developer_logs()}{" "}
					<span className="font-mono text-muted-foreground">#{taskId}</span>
				</h3>
				{task && <TaskStatus status={task.status} />}
			</div>
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{m.developer_error()}
				</p>
			)}
			{!error && (
				<Suspense fallback={<p role="status">{m.loading()}</p>}>
					{loading ? (
						<p role="status">{m.loading()}</p>
					) : (
						<TaskLogViewer text={text ?? ""} />
					)}
				</Suspense>
			)}
		</section>
	);
}
