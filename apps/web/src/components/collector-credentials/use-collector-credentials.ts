import { m } from "@pfe/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import { type RefObject, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
	CollectorCredentialSummary,
	CreateCollectorCredentialInput,
	RevealedCollectorCredential,
} from "../../credentials/contracts";
import {
	createCollectorCredential,
	revokeCollectorCredential,
	rotateCollectorCredential,
} from "../../credentials/credential.functions";
import { operationMessage } from "../../lib/operation-message";
import type {
	OperationResult,
	ProjectSummary,
} from "../../organizations/contracts";
import { useLocaleChangeBlocker } from "../locale-safety";

export interface CollectorCredentialsOptions {
	project: ProjectSummary;
	credentials: CollectorCredentialSummary[] | null;
	refreshList: () => Promise<void>;
	refreshAccess: () => Promise<void>;
}

export type CredentialAction = "rotate" | "revoke";
export type CredentialValues = Omit<
	CreateCollectorCredentialInput,
	"organizationId" | "projectId"
>;

export interface CredentialConfirmation {
	id: string;
	action: CredentialAction;
	trigger: HTMLButtonElement;
}

interface CollectorCredentialsState {
	heading: RefObject<HTMLHeadingElement | null>;
	pending: boolean;
	disabled: boolean;
	canRefresh: boolean;
	message: string;
	error: string;
	refreshError: boolean;
	reveal: RevealedCollectorCredential | null;
	confirmation: CredentialConfirmation | null;
	requestAction: (
		id: string,
		action: CredentialAction,
		trigger: HTMLButtonElement,
	) => void;
	cancelAction: () => void;
	confirmAction: () => Promise<boolean>;
	create: (values: CredentialValues) => Promise<boolean>;
	dismissToken: () => Promise<void>;
	refreshCredentials: () => Promise<void>;
}

export function useCollectorCredentials({
	project,
	credentials,
	refreshList,
	refreshAccess,
}: CollectorCredentialsOptions): CollectorCredentialsState {
	const hydrated = useHydrated();
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [refreshError, setRefreshError] = useState(false);
	const [confirmation, setConfirmation] =
		useState<CredentialConfirmation | null>(null);
	const [reveal, setReveal] = useState<RevealedCollectorCredential | null>(
		null,
	);
	const mounted = useRef(true);
	const busy = useRef(false);
	const generation = useRef(0);
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		function hide() {
			generation.current++;
			busy.current = false;
			// A frozen document can return without unmounting; remove secrets before freezing.
			flushSync(() => {
				setReveal(null);
				setConfirmation(null);
				setPending(false);
				setRefreshError(true);
				setMessage("");
				setError("");
			});
		}
		function show(event: PageTransitionEvent) {
			if (!event.persisted) return;
			const current = generation.current;
			busy.current = true;
			setPending(true);
			void refreshAccess()
				.then(() => {
					if (mounted.current && current === generation.current)
						setRefreshError(false);
				})
				.catch(() => {
					if (mounted.current && current === generation.current)
						setRefreshError(true);
				})
				.finally(() => {
					if (mounted.current && current === generation.current) {
						busy.current = false;
						setPending(false);
					}
				});
		}
		window.addEventListener("pagehide", hide);
		window.addEventListener("pageshow", show);
		return () => {
			window.removeEventListener("pagehide", hide);
			window.removeEventListener("pageshow", show);
		};
	}, [refreshAccess]);
	const reference = {
		organizationId: project.organizationId,
		projectId: project.id,
	};

	async function refresh() {
		const current = generation.current;
		try {
			await refreshList();
			if (mounted.current && current === generation.current)
				setRefreshError(false);
		} catch {
			if (mounted.current && current === generation.current)
				setRefreshError(true);
		}
	}

	async function runAction(
		action: () => Promise<
			OperationResult<CollectorCredentialSummary | RevealedCollectorCredential>
		>,
		successMessage: string,
	): Promise<boolean> {
		if (busy.current || reveal) return false;
		const current = generation.current;
		busy.current = true;
		setPending(true);
		setMessage("");
		setError("");
		try {
			const result = await action();
			if (!mounted.current || current !== generation.current) return false;
			if (result.error) {
				setError(operationMessage(result.error));
				if (
					result.error.code === "UNAUTHENTICATED" ||
					result.error.code === "FORBIDDEN" ||
					result.error.code === "NOT_FOUND"
				) {
					setRefreshError(true);
					await refreshAccess().catch(() => {});
				}
				return false;
			}
			const revealed = "token" in result.data;
			if ("token" in result.data) setReveal(result.data);
			setConfirmation(null);
			setMessage(successMessage);
			// Router invalidation also reruns parent hooks and can unmount the reveal.
			if (!revealed) {
				heading.current?.focus();
				await refresh();
			}
			return true;
		} catch {
			if (mounted.current && current === generation.current) {
				setError(m.the_response_was_lost_the_action_may_have());
				setRefreshError(true);
			}
			return false;
		} finally {
			if (current === generation.current) {
				busy.current = false;
				if (mounted.current) setPending(false);
			}
		}
	}

	async function dismissToken(): Promise<void> {
		setReveal(null);
		heading.current?.focus();
		await refreshCredentials();
	}

	async function refreshCredentials(): Promise<void> {
		if (busy.current) return;
		const current = generation.current;
		busy.current = true;
		setPending(true);
		await refresh();
		if (current === generation.current) {
			busy.current = false;
			if (mounted.current) setPending(false);
		}
	}

	function requestAction(
		id: string,
		action: CredentialAction,
		trigger: HTMLButtonElement,
	): void {
		setError("");
		setConfirmation({ id, action, trigger });
	}

	function cancelAction(): void {
		if (!busy.current) setConfirmation(null);
	}

	async function confirmAction(): Promise<boolean> {
		if (!confirmation || !credentials?.some(({ id }) => id === confirmation.id))
			return false;
		const { action, id } = confirmation;
		const data = { ...reference, credentialId: id };
		return runAction(
			() =>
				action === "rotate"
					? rotateCollectorCredential({ data })
					: revokeCollectorCredential({ data }),
			action === "rotate"
				? m.credential_rotated_save_the_replacement_token_now()
				: m.credential_revoked(),
		);
	}

	function create(values: CredentialValues): Promise<boolean> {
		return runAction(
			() => createCollectorCredential({ data: { ...reference, ...values } }),
			m.credential_created_save_the_token_now(),
		);
	}

	const disabled =
		!hydrated || pending || !!reveal || refreshError || credentials === null;
	useLocaleChangeBlocker(pending || !!reveal || refreshError);
	return {
		heading,
		pending,
		disabled,
		canRefresh: hydrated && !pending,
		message,
		error,
		refreshError,
		reveal,
		confirmation,
		requestAction,
		cancelAction,
		confirmAction,
		create,
		dismissToken,
		refreshCredentials,
	};
}
