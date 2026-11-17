import { m } from "@recount/i18n/messages";
import { useId } from "react";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../components/ui/select";
import type { TemplateVariable } from "../dashboard-templates";

// Radix Select cannot use an empty value, so "all nodes" has a sentinel.
const ALL_NODES = "-all";

/** The value a template asks for when a dashboard is created from it. */
export function TemplateVariableField({
	variable,
	value,
	nodes,
	disabled,
	onChange,
}: {
	variable: TemplateVariable;
	value: string | null | undefined;
	nodes: { id: string; hostname: string }[] | undefined;
	disabled: boolean;
	onChange: (value: string | null) => void;
}) {
	const id = useId();
	if (variable.name === "$execution")
		return (
			<div className="flex flex-col gap-2">
				<Label htmlFor={id}>{m.execution_key()}</Label>
				<Input
					id={id}
					value={value ?? ""}
					required
					maxLength={128}
					autoComplete="off"
					spellCheck={false}
					disabled={disabled}
					aria-describedby={`${id}-hint`}
					className="font-mono"
					onChange={(event) => onChange(event.target.value.trim() || null)}
				/>
				<p id={`${id}-hint`} className="text-sm text-muted-foreground">
					{m.dashboard_templates_execution_hint()}
				</p>
			</div>
		);
	return (
		<div className="flex flex-col gap-2">
			<Label htmlFor={id}>{m.dashboard_templates_node_variable()}</Label>
			<Select
				value={value ?? ALL_NODES}
				disabled={disabled || !nodes}
				onValueChange={(next) => onChange(next === ALL_NODES ? null : next)}
			>
				<SelectTrigger id={id}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ALL_NODES}>
						{m.dashboard_templates_all_nodes()}
					</SelectItem>
					{nodes?.map((item) => (
						<SelectItem key={item.id} value={item.id}>
							{item.hostname || item.id}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
