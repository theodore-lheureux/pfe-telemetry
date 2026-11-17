import { m } from "@recount/i18n/messages";
import { useId } from "react";
import { Label } from "../../components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import type { Display } from "./draft";
import { DISPLAY_LABEL } from "./labels";

export function NumberDisplayOptions({
	display,
	disabled,
	onChange,
}: {
	display: Display;
	disabled: boolean;
	onChange: (display: Display) => void;
}) {
	const id = useId();
	const chart = display.numberChart ?? "area";
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<Label htmlFor={`${id}-whole`}>{m.display_number_whole_range()}</Label>
				<Switch
					id={`${id}-whole`}
					checked={!!display.wholeRange}
					disabled={disabled}
					onCheckedChange={(on) => {
						const { wholeRange: _, ...rest } = display;
						onChange(on ? { ...rest, wholeRange: true } : rest);
					}}
				/>
			</div>
			{!display.wholeRange && (
				<NumberChartOptions
					id={id}
					display={display}
					chart={chart}
					disabled={disabled}
					onChange={onChange}
				/>
			)}
		</div>
	);
}

/** The background chart, which only a Number shown per bucket has. */
function NumberChartOptions({
	id,
	display,
	chart,
	disabled,
	onChange,
}: {
	id: string;
	display: Display;
	chart: NonNullable<Display["numberChart"]>;
	disabled: boolean;
	onChange: (display: Display) => void;
}) {
	return (
		<>
			<div className="flex items-center justify-between gap-3">
				<Label htmlFor={`${id}-show`}>{m.display_number_chart()}</Label>
				<Switch
					id={`${id}-show`}
					checked={chart !== "none"}
					disabled={disabled}
					onCheckedChange={(on) =>
						onChange({ ...display, numberChart: on ? "area" : "none" })
					}
				/>
			</div>
			{chart !== "none" && (
				<>
					<div className="flex items-center justify-between gap-3">
						<Label htmlFor={`${id}-type`}>
							{m.display_number_chart_type()}
						</Label>
						<Select
							value={chart}
							disabled={disabled}
							onValueChange={(value) =>
								onChange({
									...display,
									numberChart: value as "line" | "area" | "bar",
								})
							}
						>
							<SelectTrigger id={`${id}-type`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper">
								<SelectGroup>
									{(["line", "area", "bar"] as const).map((type) => (
										<SelectItem key={type} value={type}>
											{DISPLAY_LABEL[type]()}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>
					{chart !== "bar" && (
						<div className="flex items-center justify-between gap-3">
							<Label htmlFor={`${id}-smooth`}>{m.display_smooth()}</Label>
							<Switch
								id={`${id}-smooth`}
								checked={display.lineStyle === "smooth"}
								disabled={disabled}
								onCheckedChange={(on) =>
									onChange({
										...display,
										lineStyle: on ? "smooth" : "straight",
									})
								}
							/>
						</div>
					)}
				</>
			)}
		</>
	);
}
