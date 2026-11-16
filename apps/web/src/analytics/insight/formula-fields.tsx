import { m } from "@recount/i18n/messages";
import { PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../../components/ui/tooltip";
import type { ProjectReference } from "../../organizations/contracts";
import { calculationFromDraft } from "../calculated-draft";
import type { CalculatedMetric } from "../calculated-metrics";
import { isCalculatedMetric } from "../calculated-metrics";
import { MAX_FORMULAS } from "../contracts";
import { type DraftFormula, type InsightDraft, withDisplay } from "./draft";
import { SaveCalculatedDialog } from "./save-calculated-dialog";

/** Formula mode: named expressions that combine the series by letter. */
export function FormulaFields({
	draft,
	disabled,
	onChange,
	userId,
	reference,
	canWrite,
	editingCalculation,
}: {
	draft: InsightDraft;
	disabled: boolean;
	onChange: (draft: InsightDraft) => void;
	userId: string;
	reference: ProjectReference;
	canWrite: boolean;
	editingCalculation?: CalculatedMetric;
}) {
	const id = useId();
	const [saving, setSaving] = useState<number | null>(null);
	const saveLabel =
		editingCalculation && !editingCalculation.builtIn
			? m.calculated_save()
			: m.calculated_save_as();
	const hasCalculatedInputs = draft.series.some(
		(series) => series.metric && isCalculatedMetric(series.metric),
	);
	const setFormulas = (formulas: DraftFormula[]) =>
		onChange(withDisplay({ ...draft, formulas }, draft.display));
	const update = (index: number, change: Partial<DraftFormula>) =>
		setFormulas(
			draft.formulas.map((formula, position) =>
				position === index ? { ...formula, ...change } : formula,
			),
		);
	const sum = {
		expression: draft.series.map((entry) => entry.name).join(" + "),
	};
	return (
		<>
			<div className="flex items-center justify-between gap-2 pt-1">
				<Label htmlFor={`${id}-formula`}>{m.insight_formula_mode()}</Label>
				<Switch
					id={`${id}-formula`}
					checked={draft.formulas.length > 0}
					disabled={disabled}
					onCheckedChange={(checked) => setFormulas(checked ? [sum] : [])}
				/>
			</div>
			{draft.formulas.map((formula, index) => (
				<div
					// Formulas have no identity of their own; position names them F1, F2…
					// biome-ignore lint/suspicious/noArrayIndexKey: see above.
					key={index}
					className="flex flex-col gap-1.5 rounded-md border bg-background p-1.5"
				>
					<div className="flex items-center gap-1.5">
						<Label htmlFor={`${id}-name-${index}`} className="sr-only">
							{m.insight_formula_name({ number: index + 1 })}
						</Label>
						<Input
							id={`${id}-name-${index}`}
							value={formula.name ?? ""}
							maxLength={80}
							autoComplete="off"
							placeholder={m.insight_formula_name_placeholder()}
							disabled={disabled}
							className="h-8"
							onChange={(event) => update(index, { name: event.target.value })}
						/>
						{canWrite && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-xs"
										aria-label={saveLabel}
										className="text-muted-foreground"
										disabled={
											disabled || !calculationFromDraft(draft, index, "1")
										}
										onClick={() => setSaving(index)}
									>
										<SaveIcon aria-hidden="true" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>{saveLabel}</TooltipContent>
							</Tooltip>
						)}
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label={m.insight_formula_remove({ number: index + 1 })}
							className="text-muted-foreground"
							disabled={disabled}
							onClick={() =>
								setFormulas(
									draft.formulas.filter((_, position) => position !== index),
								)
							}
						>
							<Trash2Icon aria-hidden="true" />
						</Button>
					</div>
					<Label htmlFor={`${id}-expression-${index}`} className="sr-only">
						{m.insight_formula({ number: index + 1 })}
					</Label>
					<Input
						id={`${id}-expression-${index}`}
						value={formula.expression}
						maxLength={200}
						autoComplete="off"
						spellCheck={false}
						placeholder="(1 - A / B) * 100"
						disabled={disabled}
						className="h-8 font-mono"
						onChange={(event) =>
							update(index, { expression: event.target.value })
						}
					/>
					{canWrite && hasCalculatedInputs && (
						<p className="text-xs text-muted-foreground">
							{m.calculated_raw_only()}
						</p>
					)}
				</div>
			))}
			{saving !== null && (
				<SaveCalculatedDialog
					userId={userId}
					reference={reference}
					draft={draft}
					index={saving}
					existing={
						editingCalculation?.builtIn ? undefined : editingCalculation
					}
					onClose={() => setSaving(null)}
				/>
			)}
			{draft.formulas.length > 0 && (
				<div className="flex flex-col items-start gap-1.5">
					{!editingCalculation &&
						draft.display.type !== "stat" &&
						draft.formulas.length < MAX_FORMULAS && (
							<Button
								variant="ghost"
								size="sm"
								disabled={disabled}
								onClick={() => setFormulas([...draft.formulas, sum])}
							>
								<PlusIcon aria-hidden="true" />
								{m.insight_formula_add()}
							</Button>
						)}
					<p className="text-xs text-muted-foreground">
						{m.insight_formula_help()}
					</p>
				</div>
			)}
		</>
	);
}
