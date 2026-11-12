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
import { MAX_INSIGHT_NAME } from "../saved-insights";

/** Names an insight when saving it or renaming it. */
export function InsightNameDialog({
	open,
	title,
	initialName,
	pending,
	error,
	onClose,
	onSubmit,
}: {
	open: boolean;
	title: string;
	initialName: string;
	pending: boolean;
	error: string;
	onClose: () => void;
	onSubmit: (name: string) => void;
}) {
	const id = useId();
	const [name, setName] = useState(initialName);
	useEffect(() => {
		if (open) setName(initialName.slice(0, MAX_INSIGHT_NAME));
	}, [open, initialName]);
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
						if (name.trim()) onSubmit(name.trim());
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
					</DialogHeader>
					<div className="flex flex-col gap-2">
						<Label htmlFor={`${id}-name`} className="sr-only">
							{m.saved_name()}
						</Label>
						<Input
							id={`${id}-name`}
							value={name}
							required
							maxLength={MAX_INSIGHT_NAME}
							autoComplete="off"
							disabled={pending}
							onChange={(event) => setName(event.target.value)}
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
