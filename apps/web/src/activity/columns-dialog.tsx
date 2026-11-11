import { m } from "@recount/i18n/messages";
import { type FormEvent, useId, useMemo, useState } from "react";
import { useMetricAttributes } from "../analytics/catalog";
import { attributeField, isFieldKey } from "../analytics/fields";
import { DialogActions } from "../components/dialog-actions";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import { type OperationResult, unwrapOperation } from "../lib/operation-result";
import type { ProjectReference } from "../organizations/contracts";
import { saveExplorerColumns } from "./activity.functions";
import { AvailableColumns } from "./available-columns";
import { BUILT_IN_COLUMNS, type ExplorerColumnSettings } from "./columns";
import { VisibleColumns } from "./visible-columns";

/** Choose, order and rename Explorer columns, for oneself or as the project default. */
export function ColumnsDialog({
	open,
	onOpenChange,
	userId,
	reference,
	settings,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	userId: string;
	reference: ProjectReference;
	settings: ExplorerColumnSettings;
	onSaved: (settings: ExplorerColumnSettings) => void;
}) {
	const id = useId();
	const [draft, setDraft] = useState(settings.columns),
		[asDefault, setAsDefault] = useState(false),
		[pending, setPending] = useState(false),
		[failed, setFailed] = useState(false);
	const attributes = useMetricAttributes(userId, reference, undefined, open);
	const fields = useMemo(() => {
		const all: string[] = [...BUILT_IN_COLUMNS];
		for (const attribute of attributes.data ?? [])
			if (isFieldKey(attribute.key)) {
				const field = attributeField(attribute.scope, attribute.key);
				if (!all.includes(field)) all.push(field);
			}
		return all;
	}, [attributes.data]);
	const reset = () => {
		setDraft(settings.columns);
		setAsDefault(false);
		setFailed(false);
	};
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setPending(true);
		setFailed(false);
		try {
			const saved = unwrapOperation(
				(await saveExplorerColumns({
					data: { ...reference, columns: draft, asDefault },
				})) as OperationResult<ExplorerColumnSettings>,
			);
			onSaved(saved);
			onOpenChange(false);
		} catch {
			setFailed(true);
		} finally {
			setPending(false);
		}
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (pending) return;
				if (next) reset();
				onOpenChange(next);
			}}
		>
			<DialogContent
				className="flex flex-col gap-0 p-0 sm:max-w-2xl"
				showCloseButton={!pending}
			>
				<form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
					<DialogHeader className="border-b px-4 py-3">
						<DialogTitle>{m.activity_columns()}</DialogTitle>
					</DialogHeader>
					<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 [scrollbar-gutter:stable]">
						<section className="flex flex-col gap-2">
							<h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
								{m.columns_visible({ count: draft.length })}
							</h3>
							<VisibleColumns columns={draft} onChange={setDraft} />
						</section>
						<section className="flex flex-col gap-2">
							<h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
								{m.columns_available()}
							</h3>
							<AvailableColumns
								fields={fields}
								visible={draft.map((column) => column.field)}
								loading={attributes.isFetching}
								onAdd={(field) => setDraft([...draft, { field }])}
							/>
						</section>
						{failed && (
							<p role="alert" className="text-sm text-destructive">
								{m.columns_save_failed()}
							</p>
						)}
					</div>
					<DialogActions
						className="mx-0 mb-0 sm:items-center sm:justify-between"
						cancel={undefined}
					>
						<div className="flex flex-wrap items-center gap-3">
							<Button
								type="button"
								variant="outline"
								disabled={pending}
								onClick={() => setDraft(settings.defaults)}
							>
								{m.columns_reset()}
							</Button>
							{settings.canSetDefault && (
								<div className="flex items-center gap-2">
									<Checkbox
										id={`${id}-default`}
										checked={asDefault}
										disabled={pending}
										onCheckedChange={(checked) =>
											setAsDefault(checked === true)
										}
									/>
									<Label htmlFor={`${id}-default`}>
										{m.columns_save_default()}
									</Label>
								</div>
							)}
						</div>
						<div className="flex flex-col-reverse gap-2 sm:flex-row">
							<Button
								type="button"
								variant="outline"
								disabled={pending}
								onClick={() => onOpenChange(false)}
							>
								{m.close()}
							</Button>
							<Button type="submit" disabled={pending}>
								{m.columns_save()}
							</Button>
						</div>
					</DialogActions>
				</form>
			</DialogContent>
		</Dialog>
	);
}
