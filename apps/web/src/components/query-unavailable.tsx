import { TriangleAlertIcon } from "lucide-react";
import { operationMessage } from "../lib/operation-message";
import { MutationFailure } from "../lib/operation-result";
import { IconEmptyState } from "./workspace";

/** A failed read in place of its result, with the operation's reason when known. */
export function QueryUnavailable({
	title,
	error,
	heading,
	className,
}: {
	title: string;
	error: Error;
	heading?: "h2" | "h3" | "h4";
	className?: string;
}) {
	return (
		<IconEmptyState
			icon={<TriangleAlertIcon aria-hidden="true" />}
			title={title}
			description={
				error instanceof MutationFailure
					? operationMessage(error.failure)
					: undefined
			}
			alert
			heading={heading}
			className={className}
		/>
	);
}
