import { m } from "@pfe/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { Link, useHydrated, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAppForm } from "../components/app-form";
import { useLocaleChangeBlocker } from "../components/locale-safety";
import { useMutationNotice } from "../components/mutation-feedback";
import { Button } from "../components/ui/button";
import { inputMessage, operationMessage } from "../lib/operation-message";
import type { ProjectReference } from "../organizations/contracts";
import { createExecution } from "./execution.functions";
import { parseCreateExecution } from "./validation";

export function CreateExecutionForm({
	reference,
	sources,
	userId,
}: {
	reference: ProjectReference;
	sources: { credentialId: string; name: string; sourceId: string }[];
	userId: string;
}) {
	const router = useRouter();
	const hydrated = useHydrated();
	const publishNotice = useMutationNotice();
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const [message, setMessage] = useState("");
	const [locked, setLocked] = useState(false);
	const [savedId, setSavedId] = useState<string>();
	const form = useAppForm({
		defaultValues: {
			name: "",
			credentialId: sources[0]?.credentialId ?? "",
			hostId: "",
			startedAt: "",
			endedAt: "",
		},
		onSubmit: async ({ value }) => {
			if (!hydrated || locked) return;
			let input: ReturnType<typeof parseCreateExecution>;
			try {
				input = parseCreateExecution({ ...reference, ...value });
			} catch (error) {
				setMessage(inputMessage(error));
				return;
			}
			let current = true;
			let saved = false;
			let retainNotice = false;
			let refreshHref: string | undefined;
			let notice: ReturnType<typeof publishNotice> | undefined;
			const sameActor = () =>
				!router.state.matches.some(
					(match) =>
						"user" in match.context && match.context.user.id !== userId,
				);
			const stop = router.subscribe("onBeforeNavigate", ({ toLocation }) => {
				if (refreshHref === toLocation.href) {
					refreshHref = undefined;
					return;
				}
				current = false;
				notice?.clear();
				stop();
			});
			setMessage("");
			try {
				const result = await createExecution({ data: input });
				if (!mounted.current || !current || !sameActor()) return;
				if (result.error) {
					setMessage(operationMessage(result.error));
					if (
						["UNAUTHENTICATED", "NOT_FOUND", "FORBIDDEN"].includes(
							result.error.code,
						)
					)
						await router.invalidate();
					return;
				}
				setLocked(true);
				saved = true;
				setSavedId(result.data.executionId);
				setMessage(m.execution_recorded_if_the_saved_execution_cannot_load());
				notice = publishNotice(
					m.execution_recorded_if_the_saved_execution_cannot_load(),
				);
				refreshHref = router.state.location.href;
				await router.invalidate({ sync: true });
				if (!current || !sameActor()) notice.clear();
				else if (
					router.state.matches.some(
						(match) => match.status === "error" || match.status === "notFound",
					)
				) {
					notice.update(m.execution_recorded_but_its_page_could_not_load());
					retainNotice = true;
				} else notice.clear();
			} catch {
				if (saved && current && sameActor()) {
					notice?.update(m.execution_recorded_but_its_page_could_not_load());
					retainNotice = notice !== undefined;
				} else notice?.clear();
				if (mounted.current && current && sameActor()) {
					setLocked(true);
					setMessage(
						saved
							? m.execution_recorded_but_its_page_could_not_load()
							: m.the_recording_response_did_not_arrive_check_the(),
					);
				}
			} finally {
				// A failed-refresh notice can outlive this form; clear it on the next navigation.
				if (!retainNotice) stop();
			}
		},
	});
	const pending = useSelector(form.store, (state) => state.isSubmitting);
	useLocaleChangeBlocker(pending || locked);
	const disabled = !hydrated || pending || locked;
	return (
		<form
			method="post"
			aria-busy={pending}
			className="flex max-w-xl flex-col gap-4 rounded-xl border p-5"
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				void form.handleSubmit();
			}}
		>
			<h2 className="font-semibold">{m.record_an_execution_interval()}</h2>
			<p className="text-sm text-muted-foreground">
				{m.choose_an_enrolled_source_the_fixed_source_optional()}
			</p>
			<form.AppField name="name">
				{(field) => (
					<field.TextField
						label={m.execution_name()}
						required
						maxLength={120}
						disabled={disabled}
					/>
				)}
			</form.AppField>
			<form.AppField name="credentialId">
				{(field) => (
					<field.SelectField
						label={m.collector_source()}
						required
						disabled={disabled}
					>
						{sources.map((source) => (
							<option key={source.credentialId} value={source.credentialId}>
								{source.name} · {source.sourceId}
							</option>
						))}
					</field.SelectField>
				)}
			</form.AppField>
			<form.AppField name="hostId">
				{(field) => (
					<field.TextField
						label={m.host_id_optional_exact_match()}
						maxLength={128}
						disabled={disabled}
					/>
				)}
			</form.AppField>
			<form.AppField name="startedAt">
				{(field) => (
					<field.TextField
						label={m.start_utc_iso()}
						placeholder="2026-11-03T10:00:00Z"
						required
						disabled={disabled}
					/>
				)}
			</form.AppField>
			<form.AppField name="endedAt">
				{(field) => (
					<field.TextField
						label={m.end_utc_iso()}
						placeholder="2026-11-03T10:05:00Z"
						required
						disabled={disabled}
					/>
				)}
			</form.AppField>
			<Button type="submit" disabled={disabled}>
				{pending ? m.recording() : m.record_execution()}
			</Button>
			<p role="status" aria-live="polite">
				{message}
			</p>
			{savedId && (
				<Link
					to="/organizations/$organizationId/projects/$projectId/executions/$executionId"
					params={{ ...reference, executionId: savedId }}
					className="underline"
				>
					{m.open_saved_execution()}
				</Link>
			)}
		</form>
	);
}
