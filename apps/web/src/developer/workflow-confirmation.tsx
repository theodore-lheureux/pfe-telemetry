import { formatNumber } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { DialogActions } from "../components/dialog-actions";
import { Button } from "../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../components/ui/dialog";
import type { WorkflowInput } from "./contracts";
import { ttlLabels, workflowLabels } from "./workflow-labels";

export function WorkflowConfirmation({
	input,
	pending,
	blocked,
	error,
	onClose,
	onConfirm,
}: {
	input: WorkflowInput | null;
	pending: boolean;
	blocked: boolean;
	error: boolean;
	onClose: () => void;
	onConfirm: (input: WorkflowInput) => void;
}) {
	const creating = input?.action.startsWith("create");
	return (
		<Dialog
			open={input !== null}
			onOpenChange={(open) => {
				if (!open && !pending) onClose();
			}}
		>
			<DialogContent className="top-[10vh] translate-y-0">
				<DialogHeader>
					<DialogTitle>{input && workflowLabels()[input.action]}</DialogTitle>
					<DialogDescription>
						{creating ? m.developer_cost() : m.developer_destructive()}
					</DialogDescription>
				</DialogHeader>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
					<dt className="text-muted-foreground">{m.developer_lab()}</dt>
					<dd className="break-all font-mono text-xs">
						{input?.lab || m.developer_generated()}
					</dd>
					{creating && (
						<>
							<dt className="text-muted-foreground">{m.developer_count()}</dt>
							<dd>{formatNumber(Number(input?.count))}</dd>
							<dt className="text-muted-foreground">{m.developer_ttl()}</dt>
							<dd>{input && ttlLabels()[input.ttl]}</dd>
						</>
					)}
				</dl>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{m.developer_error()}
					</p>
				)}
				<DialogActions
					cancel={{ label: m.cancel(), disabled: pending, onClick: onClose }}
				>
					<Button
						pending={pending}
						pendingLabel={m.developer_queueing()}
						disabled={blocked}
						variant={creating ? "default" : "destructive"}
						onClick={() => {
							if (input) onConfirm(input);
						}}
					>
						{m.developer_run()}
					</Button>
				</DialogActions>
			</DialogContent>
		</Dialog>
	);
}
