import type { Locale } from "@pfe/i18n";
import { m } from "@pfe/i18n/messages";
import { getLocale, setLocale } from "@pfe/i18n/runtime";
import { useHydrated } from "@tanstack/react-router";
import { LanguagesIcon } from "lucide-react";
import { useState } from "react";
import { useLocaleChangeBlocked } from "./locale-safety";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";

export function LanguageSwitcher() {
	const hydrated = useHydrated();
	const blocked = useLocaleChangeBlocked();
	const [requested, setRequested] = useState<Locale | null>(null);
	return (
		<div className="flex items-center gap-2">
			<LanguagesIcon
				aria-hidden="true"
				className="size-4 text-muted-foreground"
			/>
			<Label htmlFor="language" className="sr-only">
				{m.language()}
			</Label>
			<NativeSelect
				id="language"
				value={getLocale()}
				disabled={!hydrated || blocked}
				aria-describedby={blocked ? "language-blocked" : undefined}
				onChange={(event) => {
					const locale = event.target.value;
					if ((locale === "en" || locale === "fr") && locale !== getLocale())
						setRequested(locale);
				}}
			>
				<NativeSelectOption value="en" lang="en">
					English
				</NativeSelectOption>
				<NativeSelectOption value="fr" lang="fr">
					Français
				</NativeSelectOption>
			</NativeSelect>
			{blocked && (
				<span id="language-blocked" className="sr-only">
					{m.language_blocked()}
				</span>
			)}
			<AlertDialog
				open={requested !== null}
				onOpenChange={(open) => {
					if (!open) setRequested(null);
				}}
			>
				<AlertDialogContent
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						document.getElementById("language")?.focus();
					}}
				>
					<AlertDialogTitle>{m.language_discard_title()}</AlertDialogTitle>
					<AlertDialogDescription>
						{m.language_discard_description()}
					</AlertDialogDescription>
					<AlertDialogFooter>
						<AlertDialogCancel>{m.cancel()}</AlertDialogCancel>
						<Button
							disabled={blocked}
							onClick={() => {
								if (requested && !blocked) void setLocale(requested);
							}}
						>
							{m.language_continue()}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
