import { createContext, useContext } from "react";
import type { TideMode } from "../components/recount/tide-mode-toggle";

export const AppearanceContext = createContext<{
	mode: TideMode;
	disabled: boolean;
	onModeChange: (mode: TideMode) => void;
} | null>(null);

export function useAppearance() {
	const appearance = useContext(AppearanceContext);
	if (!appearance) throw new Error("Appearance requires the document shell");
	return appearance;
}
