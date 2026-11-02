import { m } from "@pfe/i18n/messages";
import { type RefObject, useRef } from "react";
import type { CollectorCredentialSummary } from "../../credentials/contracts";
import { Alert, AlertDescription } from "../ui/alert";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import type { CredentialConfirmation } from "./use-collector-credentials";

export function CredentialActionDialog({
	confirmation,
	credential,
	pending,
	disabled,
	error,
	fallbackFocus,
	onConfirm,
	onCancel,
}: {
	confirmation: CredentialConfirmation;
	credential: CollectorCredentialSummary;
	pending: boolean;
	disabled: boolean;
	error: string;
	fallbackFocus: RefObject<HTMLHeadingElement | null>;
	onConfirm: () => Promise<boolean>;
	onCancel: () => void;
}) {
	const intro = useRef<HTMLParagraphElement>(null);
	const { action, trigger } = confirmation;
	return (
		<AlertDialog
			open
			onOpenChange={(open) => {
				if (!open && !pending) onCancel();
			}}
		>
			<AlertDialogContent
				onOpenAutoFocus={(event) => {
					if (action === "rotate") {
						event.preventDefault();
						intro.current?.focus();
					}
				}}
				aria-busy={pending}
				onEscapeKeyDown={(event) => {
					if (pending) event.preventDefault();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					(
						document.getElementById("token-reveal-title") ??
						(trigger.isConnected && !trigger.disabled
							? trigger
							: fallbackFocus.current)
					)?.focus();
				}}
			>
				<AlertDialogTitle>
					{action === "rotate"
						? m.confirm_rotate_named({ name: credential.name })
						: m.confirm_revoke_named({ name: credential.name })}
				</AlertDialogTitle>
				<AlertDialogDescription ref={intro} tabIndex={-1}>
					{action === "rotate"
						? m.rotation_warning({ name: credential.name })
						: m.revocation_warning({ name: credential.name })}
				</AlertDialogDescription>
				{error && (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
				<AlertDialogFooter>
					{pending && <p role="status">{m.updating_collector_credentials()}</p>}
					<Button
						variant="destructive"
						disabled={disabled}
						onClick={() => void onConfirm()}
					>
						{action === "rotate"
							? m.confirm_rotation()
							: m.confirm_revocation()}
					</Button>
					<AlertDialogCancel
						type="button"
						variant="ghost"
						disabled={pending}
						onClick={onCancel}
					>
						{m.cancel()}
					</AlertDialogCancel>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
