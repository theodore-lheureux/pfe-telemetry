import { m } from "@pfe/i18n/messages";
import { useHydrated, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useAppForm } from "../components/app-form";
import { Button } from "../components/ui/button";
import { inputMessage } from "../lib/operation-message";
import type { ExecutionReference } from "./contracts";
import { parseTimestamp } from "./validation";

export function RangeForm({
	reference,
	from,
	to,
}: {
	reference: ExecutionReference;
	from: Date;
	to: Date;
}) {
	const router = useRouter();
	const hydrated = useHydrated();
	const [message, setMessage] = useState("");
	const form = useAppForm({
		defaultValues: { from: from.toISOString(), to: to.toISOString() },
		onSubmit: async ({ value }) => {
			try {
				const from = parseTimestamp(value.from);
				const to = parseTimestamp(value.to);
				setMessage("");
				await router.navigate({
					to: "/organizations/$organizationId/projects/$projectId/executions/$executionId",
					params: reference,
					search: { from, to },
				});
			} catch (error) {
				setMessage(inputMessage(error));
			}
		},
	});
	return (
		<form
			className="flex flex-wrap items-end gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			<form.AppField name="from">
				{(field) => (
					<field.TextField
						label={m.start_utc_iso()}
						required
						disabled={!hydrated}
					/>
				)}
			</form.AppField>
			<form.AppField name="to">
				{(field) => (
					<field.TextField
						label={m.end_utc_iso()}
						required
						disabled={!hydrated}
					/>
				)}
			</form.AppField>
			<Button type="submit" disabled={!hydrated}>
				{m.apply_interval()}
			</Button>
			<p role="status">{message}</p>
		</form>
	);
}
