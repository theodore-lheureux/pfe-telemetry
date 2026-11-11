import type { Locale } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { getLocale, setLocale } from "@recount/i18n/runtime";
import { useHydrated } from "@tanstack/react-router";
import { LanguagesIcon } from "lucide-react";
import { useState } from "react";
import { AlertDialogActions } from "./dialog-actions";
import { useLocaleChangeBlocked } from "./locale-safety";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";

export function LanguageSwitcher({
	compact = false,
}: {
	/** Smaller select without the icon, for the public footer. */
	compact?: boolean;
}) {
	const hydrated = useHydrated();
	const blocked = useLocaleChangeBlocked();
	const [requested, setRequested] = useState<Locale | null>(null);
	return (
		<div className="flex items-center gap-2">
			{!compact && (
				<LanguagesIcon
					aria-hidden="true"
					className="size-4 text-muted-foreground"
				/>
			)}
			<Label htmlFor="language" className="sr-only">
				{m.language()}
			</Label>
			<NativeSelect
				id="language"
				size={compact ? "sm" : "default"}
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
					onEscapeKeyDown={(event) => {
						event.preventDefault();
						setRequested(null);
					}}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						document.getElementById("language")?.focus();
					}}
				>
					<AlertDialogTitle>{m.language_discard_title()}</AlertDialogTitle>
					<AlertDialogDescription>
						{m.language_discard_description()}
					</AlertDialogDescription>
					<AlertDialogActions cancel={{ label: m.cancel() }}>
						<Button
							disabled={blocked}
							onClick={() => {
								if (requested && !blocked) void setLocale(requested);
							}}
						>
							{m.language_continue()}
						</Button>
					</AlertDialogActions>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
