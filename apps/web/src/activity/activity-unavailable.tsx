import { m } from "@recount/i18n/messages";
import { Button } from "../components/ui/button";

export function ActivityUnavailable({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	return (
		<div role="alert" className="rounded-md border border-destructive/40 p-4">
			<p className="mb-3 text-sm">{message}</p>
			<Button variant="outline" onClick={onRetry}>
				{m.activity_retry()}
			</Button>
		</div>
	);
}
