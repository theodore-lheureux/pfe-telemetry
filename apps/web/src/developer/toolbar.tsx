import { m } from "@recount/i18n/messages";
import { ActivityIcon, TerminalIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Sheet, SheetTrigger } from "../components/ui/sheet";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../components/ui/tabs";
import type { ProjectReference } from "../organizations/contracts";
import {
	FloatingToolbarPanel,
	type PanelPosition,
} from "./floating-toolbar-panel";
import { TaskPanel } from "./task-panel";
import { WorkflowForm } from "./workflow-form";

export function DeveloperToolbar({
	userId,
	reference,
	capability,
}: {
	userId: string;
	reference: ProjectReference;
	capability: { enabled: true; gpuEnabled: boolean } | null;
}) {
	const [open, setOpen] = useState(false);
	const [view, setView] = useState("workflows");
	const [position, setPosition] = useState<PanelPosition>(null);
	const [outputOpen, setOutputOpen] = useState(false);
	if (!capability?.enabled) return null;
	return (
		<Sheet modal={false} open={open} onOpenChange={setOpen}>
			<SheetTrigger asChild>
				<Button
					className="fixed right-5 bottom-5 z-40 h-9 gap-2 rounded-full border-border bg-popover pr-2 pl-3 text-foreground shadow-lg hover:bg-accent"
					variant="outline"
					aria-label={m.developer_toolbar()}
				>
					<TerminalIcon aria-hidden="true" className="size-3.5 text-primary" />
					<span>Recount</span>
					<span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-accent-foreground">
						{m.developer_short()}
					</span>
				</Button>
			</SheetTrigger>
			{open && (
				<FloatingToolbarPanel
					position={position}
					setPosition={setPosition}
					wide={view === "activity" && outputOpen}
				>
					<Tabs value={view} onValueChange={setView} className="min-h-0 gap-0">
						<TabsList
							className="shrink-0 gap-5 px-4"
							aria-label={m.developer_toolbar()}
						>
							<TabsTrigger
								value="workflows"
								className="inline-flex items-center gap-1.5 py-3"
							>
								<WorkflowIcon className="size-3.5" aria-hidden="true" />
								{m.developer_workflows()}
							</TabsTrigger>
							<TabsTrigger
								value="activity"
								className="inline-flex items-center gap-1.5 py-3"
							>
								<ActivityIcon className="size-3.5" aria-hidden="true" />
								{m.developer_activity()}
							</TabsTrigger>
						</TabsList>
						<div className="min-h-0 overflow-y-auto p-4">
							<TabsContent
								value="workflows"
								forceMount
								hidden={view !== "workflows"}
							>
								<WorkflowForm
									userId={userId}
									reference={reference}
									gpuEnabled={capability.gpuEnabled}
								/>
							</TabsContent>
							<TabsContent value="activity">
								{view === "activity" && (
									<TaskPanel
										userId={userId}
										reference={reference}
										onOutputChange={setOutputOpen}
									/>
								)}
							</TabsContent>
						</div>
					</Tabs>
				</FloatingToolbarPanel>
			)}
		</Sheet>
	);
}
