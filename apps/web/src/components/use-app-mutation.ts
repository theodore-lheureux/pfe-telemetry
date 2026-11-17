import { m } from "@recount/i18n/messages";
import { useMutation } from "@tanstack/react-query";
import { type NavigateFn, useHydrated } from "@tanstack/react-router";
import { useState } from "react";
import { oneCreateRetry } from "../lib/mutation-create-retry";
import { operationMessage } from "../lib/operation-message";
import {
	MutationFailure,
	type OperationResult,
	unwrapOperation,
} from "../lib/operation-result";
import { useLocaleChangeBlocker } from "./locale-safety";
import { useMutationNotice } from "./mutation-feedback";
import { useMutationOwner } from "./use-mutation-owner";

type DomainError = NonNullable<OperationResult<never>["error"]>;

type Acknowledgement<Data> = {
	status: "saved" | "refreshing" | "refresh-failed" | "uncertain";
	message: string;
	data?: Data;
};
type InputMessage<Input> = string | ((input: Input) => string);
const inputMessage = <Input>(value: InputMessage<Input>, input: Input) =>
	typeof value === "function" ? value(input) : value;

/** A failed save is rejected when the server answered; otherwise its outcome is unknown. */
function errorStatus(isError: boolean, answered: boolean) {
	if (!isError) return "idle";
	return answered ? "rejected" : "uncertain";
}

function feedbackKind(status: string) {
	if (status === "rejected") return "error" as const;
	if (status === "uncertain" || status === "refresh-failed")
		return "warning" as const;
	return "success" as const;
}

export function useAppMutation<Input, Data>(options: {
	userId: string;
	save: (input: Input, signal: AbortSignal) => Promise<OperationResult<Data>>;
	saved?: InputMessage<Input>;
	refreshFailed?: InputMessage<Input>;
	unknown?: InputMessage<Input>;
	receiptBacked?: boolean;
	transientNotice?: boolean;
	errorMessage?: (error: DomainError) => string;
	/** Reports failures as toasts, for controls with no room for inline feedback. */
	toastErrors?: boolean;
}) {
	const hydrated = useHydrated();
	const { router, begin } = useMutationOwner(options.userId);
	const publishNotice = useMutationNotice();
	const mutation = useMutation({
		retry: false,
		networkMode: "always",
		gcTime: 0,
		mutationFn: async ({
			input,
			operation,
		}: {
			input: Input;
			attempt: "initial" | "retry";
			retryInput?: ReturnType<typeof oneCreateRetry<Input>>;
			operation: NonNullable<ReturnType<typeof begin>>;
		}) => unwrapOperation(await options.save(input, operation.signal)),
		onError: async (error, { operation }) => {
			if (
				operation.current() &&
				error instanceof MutationFailure &&
				["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"].includes(
					error.failure.code,
				)
			)
				await router.invalidate({ sync: true }).catch(() => {});
		},
	});
	const [acknowledgement, acknowledge] = useState<Acknowledgement<Data> | null>(
		null,
	);
	const report = (
		status: Acknowledgement<Data>["status"],
		message: string,
		data: Data,
	) => acknowledge({ status, message, data });
	const pending =
		mutation.isPending || acknowledgement?.status === "refreshing";
	const failure =
		mutation.error instanceof MutationFailure ? mutation.error.failure : null;
	const status =
		acknowledgement?.status ??
		errorStatus(
			mutation.isError,
			!!failure && mutation.variables?.attempt !== "retry",
		);
	const unknownFor = (input: Input) =>
		inputMessage(
			options.unknown ?? m.the_response_was_lost_the_action_may_have(),
			input,
		);
	const unknown = mutation.variables
		? unknownFor(mutation.variables.input)
		: m.the_response_was_lost_the_action_may_have();
	const message = inlineMessage();
	function inlineMessage() {
		// Confirmations are toasts; only problems stay next to the form.
		if (options.toastErrors || feedbackKind(status) === "success") return "";
		return acknowledgement?.message ?? errorMessage();
	}
	function errorMessage() {
		if (!mutation.isError) return "";
		if (!failure) return unknown;
		return failureMessage(failure);
	}
	function failureMessage(failure: DomainError) {
		return options.errorMessage?.(failure) ?? operationMessage(failure);
	}
	useLocaleChangeBlocker(
		pending || status === "uncertain" || status === "refresh-failed",
	);

	async function toastFailure(failure: DomainError | null, unknown: string) {
		publishNotice(failure ? failureMessage(failure) : unknown, true, "error");
		// Without inline feedback, show what the server holds after a lost response.
		if (!failure) await router.invalidate({ sync: true }).catch(() => {});
	}

	async function run(input: Input, attempt: "initial" | "retry") {
		if (!hydrated) return;
		const unknown = unknownFor(input);
		const saved = inputMessage(options.saved ?? m.changes_saved(), input);
		const operation = begin((reason) => {
			mutation.reset();
			acknowledge((previous) => {
				if (reason === "identity") return null;
				if (previous && previous.status !== "uncertain")
					return {
						...previous,
						status:
							previous.status === "refreshing" ? "saved" : previous.status,
						data: reason === "document" ? undefined : previous.data,
					};
				return options.receiptBacked
					? { status: "uncertain", message: unknown }
					: null;
			});
		});
		if (!operation) return;
		acknowledge(null);
		let data: Data;
		try {
			data = await mutation.mutateAsync({
				input,
				attempt,
				operation,
				retryInput:
					options.receiptBacked && attempt === "initial"
						? oneCreateRetry(input, operation.current)
						: undefined,
			});
		} catch (error) {
			operation.finish();
			const answered = error instanceof MutationFailure;
			if (options.toastErrors && operation.current())
				await toastFailure(answered ? error.failure : null, unknown);
			return operation.current() && answered
				? { error: error.failure }
				: undefined;
		}
		if (!operation.current()) {
			operation.finish();
			return;
		}
		report("saved", saved, data);
		return {
			error: null,
			data,
			input,
			async refresh(
				afterRefresh?: (navigate: NavigateFn) => Promise<void>,
				success = m.changes_saved(),
			) {
				if (!operation.current()) {
					operation.finish();
					return false;
				}
				const unavailable = inputMessage(
					options.refreshFailed ??
						m.your_change_was_saved_but_the_page_could_2(),
					input,
				);
				report("refreshing", saved, data);
				const refreshed = await operation
					.refresh(
						saved,
						unavailable,
						afterRefresh,
						options.transientNotice,
						success,
					)
					.catch(() => false);
				operation.finish();
				if (!operation.current()) return false;
				report(
					refreshed ? "saved" : "refresh-failed",
					refreshed ? success : unavailable,
					data,
				);
				return refreshed;
			},
		};
	}
	const canRetry = !!(
		options.receiptBacked &&
		mutation.isError &&
		!failure &&
		mutation.variables.retryInput &&
		mutation.variables.operation.current()
	);
	return {
		status,
		message,
		data: acknowledgement?.data,
		kind: feedbackKind(status),
		canRetry,
		pending,
		disabled: !hydrated || pending,
		submit: (input: Input) => run(input, "initial"),
		clearMessage() {
			mutation.reset();
			acknowledge(null);
		},
		async retry() {
			const retry = canRetry ? mutation.variables?.retryInput?.() : null;
			if (retry) return run(retry.input, "retry");
		},
	};
}
