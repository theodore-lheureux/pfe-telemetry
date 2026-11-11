import { m } from "@recount/i18n/messages";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	MonitorIcon,
	MoonIcon,
	SunIcon,
} from "lucide-react";
import type { ThemeMode } from "../lib/theme";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export function ThemeSelector({
	mode,
	onModeChange,
	disabled,
	compact = false,
}: {
	mode: ThemeMode;
	onModeChange: (mode: ThemeMode) => void;
	disabled: boolean;
	/** A quieter trigger that opens upward, for the public footer. */
	compact?: boolean;
}) {
	const choices = [
		{ value: "light", label: m.theme_light(), Icon: SunIcon },
		{ value: "dark", label: m.theme_dark(), Icon: MoonIcon },
		{ value: "system", label: m.theme_system(), Icon: MonitorIcon },
	] as const;
	const selected =
		choices.find((choice) => choice.value === mode) ?? choices[0];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant={compact ? "ghost" : "outline"}
					size={compact ? "sm" : "default"}
					disabled={disabled}
					aria-label={m.theme()}
					className={compact ? "text-muted-foreground" : undefined}
				>
					<selected.Icon aria-hidden="true" />
					{selected.label}
					{compact ? (
						<ChevronDownIcon aria-hidden="true" className="size-3.5" />
					) : (
						<ChevronRightIcon aria-hidden="true" className="ml-3 size-4" />
					)}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				side={compact ? "top" : "right"}
				align={compact ? "end" : "start"}
				className="min-w-(--radix-dropdown-menu-trigger-width)"
			>
				<DropdownMenuRadioGroup
					value={mode}
					onValueChange={(value) => {
						if (value === "light" || value === "dark" || value === "system")
							onModeChange(value);
					}}
				>
					{choices.map((choice) => (
						<DropdownMenuRadioItem
							key={choice.value}
							value={choice.value}
							className="min-h-9 gap-2 data-[state=checked]:bg-muted"
						>
							<choice.Icon aria-hidden="true" />
							{choice.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
