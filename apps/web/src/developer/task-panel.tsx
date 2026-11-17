import { formatDate } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, HistoryIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import {
	Empty,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import { unwrapOperation } from "../lib/operation-result";
import { cn } from "../lib/utils";
import type { ProjectReference } from "../organizations/contracts";
import { developerOutput, developerTasks } from "./developer.functions";
import { TaskOutput } from "./task-output";
import { TaskStatus } from "./task-status";
import { workflowLabels } from "./workflow-labels";

export function TaskPanel({
	userId,
	reference,
	onOutputChange,
}: {
	userId: string;
	reference: ProjectReference;
	onOutputChange: (open: boolean) => void;
}) {
	const client = useQueryClient();
	const [taskId, setTaskId] = useState<number | null>(null);
	const key = [
		"developer",
		userId,
		reference.organizationId,
		reference.projectId,
	];
	useEffect(
		() => () => {
			client.removeQueries({ queryKey: ["developer", userId] });
			onOutputChange(false);
		},
		[client, userId, onOutputChange],
	);
	const tasks = useQuery({
		queryKey: [...key, "tasks"],
		queryFn: async ({ signal }) =>
			unwrapOperation(await developerTasks({ data: reference, signal })),
		refetchInterval: (query) => (query.state.status === "error" ? false : 5000),
		retry: false,
		gcTime: 0,
		staleTime: 0,
	});
	const output = useQuery({
		queryKey: [...key, "output", taskId],
		queryFn: async ({ signal }) =>
			unwrapOperation(
				await developerOutput({
					data: { ...reference, taskId: taskId ?? 0 },
					signal,
				}),
			),
		enabled: taskId !== null && !tasks.isError,
		refetchInterval: (query) => (query.state.status === "error" ? false : 5000),
		retry: false,
		gcTime: 0,
		staleTime: 0,
	});
	function selectTask(id: number | null) {
		setTaskId(id);
		onOutputChange(id !== null);
	}
	const labels = workflowLabels();
	return (
		<section
			className={cn(
				"grid min-w-0 gap-4",
				taskId !== null && "md:grid-cols-[260px_minmax(0,1fr)]",
			)}
		>
			<div
				className={cn(
					"min-w-0 space-y-3",
					taskId !== null && "hidden md:block",
				)}
			>
				<div className="flex items-center justify-between">
					<h3 className="text-xs font-medium">{m.developer_recent()}</h3>
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={m.developer_refresh()}
						title={m.developer_refresh()}
						pending={tasks.isFetching}
						onClick={() => {
							void tasks.refetch();
						}}
					>
						<RefreshCwIcon
							className={cn(
								"size-3",
								tasks.isFetching && "motion-safe:animate-spin",
							)}
							aria-hidden="true"
						/>
					</Button>
				</div>
				{tasks.isError && (
					<p role="alert" className="text-xs text-destructive">
						{m.developer_error()}
					</p>
				)}
				{tasks.isPending && (
					<div role="status" aria-label={m.loading()} className="space-y-2">
						<Skeleton className="h-16 w-full" />
						<Skeleton className="h-16 w-full" />
					</div>
				)}
				{!tasks.isError && tasks.data?.length === 0 && (
					<Empty className="border py-8">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HistoryIcon aria-hidden="true" />
							</EmptyMedia>
							<EmptyTitle>{m.developer_no_tasks()}</EmptyTitle>
						</EmptyHeader>
					</Empty>
				)}
				<ul className="max-h-[420px] space-y-1.5 overflow-y-auto">
					{!tasks.isError &&
						tasks.data?.map((task) => (
							<li key={task.id}>
								<Button
									variant="ghost"
									aria-label={`#${task.id} · ${labels[task.action]}`}
									aria-pressed={taskId === task.id}
									className={cn(
										"h-auto! w-full justify-start gap-2 whitespace-normal rounded-lg border border-border px-3 py-2.5 text-left",
										taskId === task.id && "border-primary/40 bg-accent/40",
									)}
									onClick={() => selectTask(task.id)}
								>
									<span className="min-w-0 flex-1 space-y-1.5">
										<span className="flex flex-wrap items-center justify-between gap-2">
											<span className="truncate text-xs font-medium">
												{labels[task.action]}
											</span>
											<TaskStatus status={task.status} />
										</span>
										<span className="flex flex-wrap items-center gap-x-2 text-[10px] font-normal text-muted-foreground">
											<span className="font-mono">#{task.id}</span>
											{task.created && (
												<time dateTime={task.created}>
													{formatDate(task.created)}
												</time>
											)}
										</span>
									</span>
									<ChevronRightIcon
										className="size-3 text-muted-foreground"
										aria-hidden="true"
									/>
								</Button>
							</li>
						))}
				</ul>
			</div>
			{taskId !== null && (
				<TaskOutput
					taskId={taskId}
					task={tasks.data?.find((task) => task.id === taskId)}
					text={output.data}
					loading={output.isPending}
					error={tasks.isError || output.isError}
					onBack={() => selectTask(null)}
				/>
			)}
		</section>
	);
}
