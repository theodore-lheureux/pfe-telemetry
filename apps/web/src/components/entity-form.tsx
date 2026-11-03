import { m } from "@pfe/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import {
	isNotFound,
	useHydrated,
	useLocation,
	useRouteContext,
	useRouter,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { operationMessage } from "../lib/operation-message";
import type {
	OperationResult,
	OrganizationInput,
} from "../organizations/contracts";
import { useAppForm } from "./app-form";
import { useLocaleChangeBlocker } from "./locale-safety";
import { useMutationFeedback } from "./mutation-feedback";
import { Button } from "./ui/button";

interface EntityFormProps<T> {
	name?: string;
	slug?: boolean;
	submitLabel: string;
	save: (input: OrganizationInput) => Promise<OperationResult<T>>;
	onSuccess: (data: T, recover: (href: string) => void) => Promise<void>;
}

export function EntityForm<T>(props: EntityFormProps<T>) {
	const { user } = useRouteContext({ from: "/_app" });
	const locationKey = useLocation({
		select: (location) => location.state.__TSR_key,
	});
	return (
		<EntityFields
			key={`${user.id}/${locationKey}`}
			{...props}
			userId={user.id}
		/>
	);
}

function EntityFields<T>({
	name = "",
	slug,
	submitLabel,
	save,
	onSuccess,
	userId,
}: EntityFormProps<T> & { userId: string }) {
	const router = useRouter();
	const setFeedback = useMutationFeedback();
	const hydrated = useHydrated();
	const [savedWithoutRefresh, setSavedWithoutRefresh] = useState(false);
	const [message, setMessage] = useState("");
	const lifetime = useRef({
		mounted: false,
		generation: 0,
		refreshing: false,
		boundary: false,
		navigating: false,
		origin: "",
	});
	useEffect(() => {
		const state = lifetime.current;
		state.mounted = true;
		return () => {
			state.mounted = false;
			state.boundary =
				state.refreshing &&
				router.state.location.href === state.origin &&
				(state.navigating ||
					router.state.isLoading ||
					router.state.matches.some(
						(match) =>
							match.status === "error" ||
							match.status === "notFound" ||
							isNotFound(match.error),
					));
			if (!state.boundary) state.generation++;
		};
	}, [router]);
	const form = useAppForm({
		defaultValues: { name, slug: "" },
		onSubmit: async ({ value }) => submit(value),
	});
	const pending = useSelector(form.store, (state) => state.isSubmitting);
	useLocaleChangeBlocker(pending || savedWithoutRefresh);
	async function submit(value: { name: string; slug: string }) {
		if (!hydrated || savedWithoutRefresh) return;
		const state = lifetime.current;
		const generation = ++state.generation;
		state.origin = router.state.location.href;
		state.refreshing = false;
		state.boundary = false;
		state.navigating = false;
		let recoveryHref: string | undefined;
		const stop = router.subscribe("onBeforeNavigate", ({ toLocation }) => {
			if (state.generation !== generation) return;
			if (recoveryHref !== undefined && toLocation.href === recoveryHref) {
				recoveryHref = undefined;
				state.origin = toLocation.href;
				return;
			}
			state.generation++;
		});
		const ownsRefresh = () =>
			state.generation === generation &&
			router.state.location.href === state.origin &&
			!router.state.matches.some(
				(match) => "user" in match.context && match.context.user.id !== userId,
			) &&
			(state.mounted || state.boundary);
		const current = () => state.mounted && ownsRefresh();
		setMessage("");
		setFeedback(null);
		let saved = false;
		try {
			const result = await save({ name: value.name.trim(), slug: value.slug });
			if (!current()) return;
			if (result.error) {
				if (result.error.code === "CONFLICT" && slug) {
					form.setFieldMeta("slug", (meta) => ({
						...meta,
						isTouched: true,
						errorMap: {
							...meta.errorMap,
							onSubmit: m.this_slug_is_already_in_use_choose_another(),
						},
					}));
				}
				setMessage(
					result.error.code === "CONFLICT"
						? m.this_slug_is_already_in_use_choose_another()
						: operationMessage(result.error),
				);
				if (
					["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"].includes(
						result.error.code,
					)
				)
					await router.invalidate({ sync: true });
				return;
			}
			saved = true;
			setFeedback(m.your_change_was_saved_refreshing_the_page());
			state.refreshing = true;
			recoveryHref = router.state.location.href;
			await router.invalidate({ sync: true });
			if (!ownsRefresh()) return;
			await onSuccess(result.data, (href) => {
				state.navigating = true;
				recoveryHref = href;
			});
			if (!ownsRefresh()) return;
			if (
				router.state.matches.some(
					(match) =>
						match.status === "error" ||
						match.status === "notFound" ||
						isNotFound(match.error),
				)
			) {
				if (current()) setSavedWithoutRefresh(true);
				setFeedback(m.your_change_was_saved_but_the_page_could_2());
				return;
			}
			setFeedback(null);
			if (current()) {
				form.reset({ name: value.name.trim(), slug: value.slug });
				setMessage(m.changes_saved());
			}
		} catch {
			if (saved && ownsRefresh())
				setFeedback(m.your_change_was_saved_but_the_page_could_2());
			if (!current()) return;
			setSavedWithoutRefresh(true);
			setMessage(
				saved
					? m.your_change_was_saved_but_the_page_could()
					: m.the_response_was_lost_the_action_may_have(),
			);
		} finally {
			stop();
		}
	}
	return (
		<form
			method="post"
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				void form.handleSubmit();
			}}
			className="flex max-w-xl flex-col gap-4 rounded-lg border bg-card p-5 text-card-foreground"
			aria-busy={pending}
		>
			<form.AppField
				name="name"
				validators={{
					onChange: ({ value }) =>
						!value.trim() ? m.enter_a_name_not_just_spaces() : undefined,
				}}
			>
				{(field) => (
					<field.TextField
						id="entity-name"
						label={m.name()}
						required
						maxLength={120}
						disabled={!hydrated || pending || savedWithoutRefresh}
						aria-describedby="entity-message"
						autoComplete="off"
					/>
				)}
			</form.AppField>
			{slug && (
				<form.AppField name="slug">
					{(field) => (
						<field.TextField
							id="entity-slug"
							label={m.slug()}
							required
							maxLength={63}
							pattern="[a-z0-9]+(-[a-z0-9]+)*"
							disabled={!hydrated || pending || savedWithoutRefresh}
							aria-describedby="entity-message"
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
							description={m.use_lowercase_letters_numbers_and_single_hyphens_the()}
						/>
					)}
				</form.AppField>
			)}
			<div>
				<Button
					type="submit"
					disabled={!hydrated || pending || savedWithoutRefresh}
				>
					{pending ? m.saving() : submitLabel}
				</Button>
			</div>
			<p
				id="entity-message"
				role="status"
				aria-live="polite"
				className="text-sm"
			>
				{message}
			</p>
		</form>
	);
}
