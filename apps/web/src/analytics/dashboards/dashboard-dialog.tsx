import { m } from "@recount/i18n/messages";
import { useEffect, useId, useState } from "react";
import { DialogActions } from "../../components/dialog-actions";
import { FormFeedback } from "../../components/form-feedback";
import { Button } from "../../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { MAX_DASHBOARD_DESCRIPTION, MAX_DASHBOARD_NAME } from "../dashboards";

/** Names and describes a dashboard when creating or editing it. */
export function DashboardDialog({
	open,
	title,
	initial,
	pending,
	error,
	onClose,
	onSubmit,
}: {
	open: boolean;
	title: string;
	initial: { name: string; description: string };
	pending: boolean;
	error: string;
	onClose: () => void;
	onSubmit: (value: { name: string; description: string }) => void;
}) {
	const id = useId();
	const [name, setName] = useState(initial.name),
		[description, setDescription] = useState(initial.description);
	useEffect(() => {
		if (!open) return;
		setName(initial.name);
		setDescription(initial.description);
	}, [open, initial.name, initial.description]);
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !pending) onClose();
			}}
		>
			<DialogContent className="sm:max-w-md" showCloseButton={!pending}>
				<form
					method="post"
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (name.trim())
							onSubmit({ name: name.trim(), description: description.trim() });
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
					</DialogHeader>
					<div className="flex flex-col gap-2">
						<Label htmlFor={`${id}-name`}>{m.dashboard_name()}</Label>
						<Input
							id={`${id}-name`}
							value={name}
							required
							maxLength={MAX_DASHBOARD_NAME}
							autoComplete="off"
							disabled={pending}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor={`${id}-description`}>
							{m.dashboard_description()}
						</Label>
						<Textarea
							id={`${id}-description`}
							value={description}
							maxLength={MAX_DASHBOARD_DESCRIPTION}
							disabled={pending}
							rows={3}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</div>
					<FormFeedback message={error} kind="error" reserveLine={false} />
					<DialogActions
						cancel={{ label: m.cancel(), disabled: pending, onClick: onClose }}
					>
						<Button
							type="submit"
							disabled={pending || !name.trim()}
							pending={pending}
							pendingLabel={m.saving()}
						>
							{m.saved_save()}
						</Button>
					</DialogActions>
				</form>
			</DialogContent>
		</Dialog>
	);
}
