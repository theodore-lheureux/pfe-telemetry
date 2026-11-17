import { m } from "@recount/i18n/messages";
import { ArrowLeftIcon, ExternalLinkIcon, Maximize2Icon } from "lucide-react";
import { lazy, Suspense } from "react";
import { Button } from "../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "../components/ui/dialog";
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
		<section
			aria-label={m.developer_logs()}
			className="ph-no-capture rr-block min-w-0 space-y-3"
		>
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
					<OutputTitle taskId={taskId} />
				</h3>
				<div className="flex items-center gap-1">
					{task && <TaskStatus status={task.status} />}
					{!error && !loading && Boolean(text?.trim()) && (
						<FullScreenLog taskId={taskId} text={text ?? ""} />
					)}
				</div>
			</div>
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{m.developer_error()}
				</p>
			)}
			{!error && !loading && !text?.trim() && (
				<p
					role="status"
					className="rounded-lg border p-3 text-sm text-muted-foreground"
				>
					{m.developer_output_empty()}
				</p>
			)}
			{!error && (loading || Boolean(text?.trim())) && (
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

function OutputTitle({ taskId }: { taskId: number }) {
	return (
		<>
			{m.developer_logs()}{" "}
			<span className="font-mono text-muted-foreground">#{taskId}</span>
		</>
	);
}

function FullScreenLog({ taskId, text }: { taskId: number; text: string }) {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={m.developer_log_full_screen()}
					title={m.developer_log_full_screen()}
				>
					<Maximize2Icon aria-hidden="true" />
				</Button>
			</DialogTrigger>
			<DialogContent className="ph-no-capture rr-block flex h-[calc(100dvh-2rem)] flex-col sm:h-[calc(100dvh-4rem)] sm:max-w-[calc(100%-4rem)]">
				<DialogTitle className="text-sm">
					<OutputTitle taskId={taskId} />
				</DialogTitle>
				<Suspense fallback={<p role="status">{m.loading()}</p>}>
					<TaskLogViewer text={text} className="h-auto min-h-0 flex-1" />
				</Suspense>
			</DialogContent>
		</Dialog>
	);
}
