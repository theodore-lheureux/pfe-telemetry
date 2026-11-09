import { createContext, useContext } from "react";
import type { ThemeMode } from "./theme";

export const AppearanceContext = createContext<{
	mode: ThemeMode;
	disabled: boolean;
	onModeChange: (mode: ThemeMode) => void;
} | null>(null);

export function useAppearance() {
	const appearance = useContext(AppearanceContext);
	if (!appearance) throw new Error("Appearance requires the document shell");
	return appearance;
}
