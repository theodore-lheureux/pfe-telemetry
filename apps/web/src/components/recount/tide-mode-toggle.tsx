import { m } from "@recount/i18n/messages";
import { MoonIcon, SunIcon } from "lucide-react";
import { Button } from "../ui/button";

export type TideMode = "light" | "dark";

export function TideModeToggle({
	mode,
	onModeChange,
	disabled,
}: {
	mode: TideMode;
	onModeChange: (mode: TideMode) => void;
	disabled: boolean;
}) {
	const dark = mode === "dark";
	const Icon = dark ? SunIcon : MoonIcon;
	const label = dark ? m.theme_switch_light() : m.theme_switch_dark();
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={() => onModeChange(dark ? "light" : "dark")}
		>
			<Icon aria-hidden="true" />
		</Button>
	);
}
