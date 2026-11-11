import type { ComponentProps, ReactNode, Ref } from "react";
import { cn } from "../lib/utils";
import { AlertDialogCancel, AlertDialogFooter } from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { DialogFooter } from "./ui/dialog";

// Dialog actions share one layout: a footer with an outline cancel first and the
// confirming action last, so the primary action sits at the right on wide screens and on
// top on narrow ones. Use these instead of composing footer buttons by hand.

interface CancelAction {
	label: ReactNode;
	onClick?: () => void;
	disabled?: boolean;
	ref?: Ref<HTMLButtonElement>;
}

export function DialogActions({
	cancel,
	children,
	className,
}: {
	cancel?: CancelAction;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<DialogFooter className={className}>
			{cancel && (
				<Button
					ref={cancel.ref}
					type="button"
					variant="outline"
					disabled={cancel.disabled}
					onClick={cancel.onClick}
				>
					{cancel.label}
				</Button>
			)}
			{children}
		</DialogFooter>
	);
}

export function AlertDialogActions({
	cancel,
	children,
}: {
	cancel: CancelAction;
	children: ReactNode;
}) {
	return (
		<AlertDialogFooter>
			<AlertDialogCancel
				type="button"
				variant="outline"
				disabled={cancel.disabled}
				onClick={cancel.onClick}
			>
				{cancel.label}
			</AlertDialogCancel>
			{children}
		</AlertDialogFooter>
	);
}

/** Alternative full-width actions stacked in a narrow surface, such as sign-in choices. */
export function ActionStack({ className, ...props }: ComponentProps<"div">) {
	return <div className={cn("flex flex-col gap-2", className)} {...props} />;
}
