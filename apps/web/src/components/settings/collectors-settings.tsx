import { usePostHog } from "@posthog/react";
import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { useHydrated } from "@tanstack/react-router";
import { type ColumnDef, tableFeatures, useTable } from "@tanstack/react-table";
import { BanIcon, CheckIcon, CopyIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
	createEnrollmentKey,
	revokeEnrollmentKey,
} from "../../collectors/collector.functions";
import type {
	EnrollmentKeySummary,
	RevealedEnrollmentKey,
} from "../../collectors/contracts";
import { operationMessage } from "../../lib/operation-message";
import type { OperationResult } from "../../lib/operation-result";
import type { ProjectSummary } from "../../organizations/contracts";
import { CopyStatus } from "../copy-status";
import { DataTable } from "../data-table";
import { AlertDialogActions, DialogActions } from "../dialog-actions";
import { FormFeedback } from "../form-feedback";
import { TimeDisplay } from "../time-display";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect, NativeSelectOption } from "../ui/native-select";
import { useMutationOwner } from "../use-mutation-owner";
import { SettingsPageHeading } from "./settings-page-heading";
import { SettingsSection } from "./settings-section";

type Confirmation = { kind: "revoke-key"; key: EnrollmentKeySummary };

export function CollectorsSettings({
	project,
	userId,
	enrollmentKeys,
}: {
	project: ProjectSummary;
	userId: string;
	enrollmentKeys: EnrollmentKeySummary[];
}) {
	const hydrated = useHydrated();
	const posthog = usePostHog();
	const { begin } = useMutationOwner(userId);
	const reference = {
		organizationId: project.organizationId,
		projectId: project.id,
	};
	const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
	// One dialog serves every confirmation, so focus returns to whichever control opened it.
	const confirmationTrigger = useRef<HTMLElement | null>(null);
	function openConfirmation(next: Confirmation) {
		confirmationTrigger.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		setConfirmation(next);
	}
	const [creating, setCreating] = useState(false);
	const [reveal, setReveal] = useState<RevealedEnrollmentKey | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	async function mutate<T>(
		action: (signal: AbortSignal) => Promise<OperationResult<T>>,
		done: string,
		after?: (data: T) => void,
	) {
		const operation = begin((reason) => {
			const clear = () => {
				setReveal(null);
				setConfirmation(null);
				setPending(false);
			};
			// A frozen document can return without unmounting; remove secrets before freezing.
			if (reason === "document") flushSync(clear);
			else clear();
		});
		if (!operation) return false;
		setPending(true);
		setError("");
		try {
			const result = await action(operation.signal);
			if (!operation.current()) return false;
			if (result.error) {
				setError(operationMessage(result.error));
				return false;
			}
			// Refresh before revealing anything so a later failed reload cannot replace the
			// page while a one-time key is on screen.
			await operation
				.refresh(done, m.your_change_was_saved_but_the_page_could_2())
				.catch(() => false);
			if (!operation.current()) return false;
			after?.(result.data);
			return true;
		} finally {
			if (operation.current()) setPending(false);
			operation.finish();
		}
	}

	return (
		<div className="flex flex-col gap-8">
			<SettingsPageHeading description={m.collectors_description()} />
			<SettingsSection
				id="enrollment-keys"
				title={m.enrollment_keys()}
				description={m.enrollment_keys_description()}
				actions={
					<Button
						variant="outline"
						disabled={!hydrated || pending}
						onClick={() => setCreating(true)}
					>
						<PlusIcon aria-hidden="true" />
						{m.enrollment_key_create()}
					</Button>
				}
			>
				{enrollmentKeys.length === 0 ? (
					<Empty className="border border-dashed bg-card p-6">
						<EmptyDescription>{m.enrollment_keys_empty()}</EmptyDescription>
					</Empty>
				) : (
					<EnrollmentKeysTable
						enrollmentKeys={enrollmentKeys}
						disabled={!hydrated || pending}
						onRevoke={(key) => openConfirmation({ kind: "revoke-key", key })}
					/>
				)}
			</SettingsSection>
			<FormFeedback message={error} kind="error" reserveLine={false} />
			<CreateEnrollmentKeyDialog
				open={creating}
				pending={pending}
				error={error}
				onClose={() => setCreating(false)}
				onCreate={async (values) => {
					const created = await mutate(
						(signal) =>
							createEnrollmentKey({
								data: { ...reference, ...values },
								signal,
							}),
						m.enrollment_key_created_done(),
						(created) => {
							setCreating(false);
							setReveal(created);
						},
					);
					if (created)
						posthog.capture("enrollment_key_created", {
							has_node_limit: values.maxNodes !== null,
							has_expiry: values.expiresAt !== null,
						});
					return created;
				}}
			/>
			<RevealDialog
				key={reveal?.enrollmentKey.id ?? "closed"}
				reveal={reveal}
				onClose={() => setReveal(null)}
			/>
			<AlertDialog
				open={confirmation !== null}
				onOpenChange={(open) => {
					if (!open && !pending) setConfirmation(null);
				}}
			>
				<AlertDialogContent
					onCloseAutoFocus={(event) => {
						const trigger = confirmationTrigger.current;
						if (trigger?.isConnected) {
							event.preventDefault();
							trigger.focus();
						}
					}}
				>
					<AlertDialogTitle>
						{confirmation &&
							m.enrollment_key_revoke_title({ name: confirmation.key.name })}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{m.enrollment_key_revoke_description()}
					</AlertDialogDescription>
					<FormFeedback message={error} kind="error" reserveLine={false} />
					<AlertDialogActions
						cancel={{
							label: m.cancel(),
							disabled: pending,
							onClick: () => setConfirmation(null),
						}}
					>
						<Button
							variant="destructive"
							disabled={pending}
							pending={pending}
							pendingLabel={m.saving()}
							onClick={() => {
								if (!confirmation) return;
								void mutate(
									(signal) =>
										revokeEnrollmentKey({
											data: {
												...reference,
												enrollmentKeyId: confirmation.key.id,
											},
											signal,
										}),
									m.enrollment_key_revoked_done(),
									() => setConfirmation(null),
								).then((revoked) => {
									if (revoked) posthog.capture("enrollment_key_revoked");
								});
							}}
						>
							{m.enrollment_key_revoke()}
						</Button>
					</AlertDialogActions>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

const keyTableFeatures = tableFeatures({});
type KeyTableMeta = {
	disabled: boolean;
	onRevoke: (key: EnrollmentKeySummary) => void;
};
const keyColumns: ColumnDef<typeof keyTableFeatures, EnrollmentKeySummary>[] = [
	{
		id: "name",
		header: () => m.name(),
		cell: ({ row }) => (
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium">{row.original.name}</span>
				{row.original.labels.map((label) => (
					<Badge key={label} variant="outline">
						{label}
					</Badge>
				))}
			</div>
		),
	},
	{
		id: "status",
		header: () => m.settings_status(),
		cell: ({ row }) =>
			keyIsActive(row.original) ? (
				<Badge
					variant="outline"
					className="border-green-600 text-green-700 dark:text-green-400"
				>
					{m.enrollment_key_status_active()}
				</Badge>
			) : (
				<Badge variant="secondary">
					{row.original.revokedAt
						? m.enrollment_key_status_revoked()
						: m.enrollment_key_status_expired()}
				</Badge>
			),
	},
	{
		id: "nodes",
		header: () => m.nodes(),
		cell: ({ row }) => (
			<span className="tabular-nums">
				{row.original.maxNodes === null
					? m.enrollment_key_nodes({ count: row.original.activeNodes })
					: m.enrollment_key_nodes_limit({
							count: row.original.activeNodes,
							limit: row.original.maxNodes,
						})}
			</span>
		),
	},
	{
		id: "created",
		meta: { className: "whitespace-nowrap" },
		header: () => m.created(),
		cell: ({ row }) => (
			<TimeDisplay value={row.original.createdAt} mode="compact" />
		),
	},
	{
		id: "expires",
		meta: { className: "whitespace-nowrap" },
		header: () => m.enrollment_key_expires(),
		cell: ({ row }) =>
			row.original.expiresAt ? (
				<TimeDisplay value={row.original.expiresAt} mode="compact" />
			) : (
				<span className="text-muted-foreground">
					{m.enrollment_key_never_expires()}
				</span>
			),
	},
	{
		id: "actions",
		header: () => <span className="sr-only">{m.actions()}</span>,
		cell: ({ row, table }) => (
			<div className="flex justify-end">
				{keyIsActive(row.original) && (
					<Button
						variant="ghost"
						size="icon"
						className="text-destructive"
						aria-label={m.enrollment_key_revoke_named({
							name: row.original.name,
						})}
						title={m.enrollment_key_revoke()}
						disabled={(table.options.meta as KeyTableMeta).disabled}
						onClick={() =>
							(table.options.meta as KeyTableMeta).onRevoke(row.original)
						}
					>
						<BanIcon aria-hidden="true" />
					</Button>
				)}
			</div>
		),
	},
];

function keyIsActive(enrollmentKey: EnrollmentKeySummary) {
	return (
		!enrollmentKey.revokedAt &&
		(enrollmentKey.expiresAt === null ||
			enrollmentKey.expiresAt.getTime() > Date.now())
	);
}

function EnrollmentKeysTable({
	enrollmentKeys,
	disabled,
	onRevoke,
}: {
	enrollmentKeys: EnrollmentKeySummary[];
	disabled: boolean;
	onRevoke: (key: EnrollmentKeySummary) => void;
}) {
	const meta: KeyTableMeta = { disabled, onRevoke };
	const table = useTable({
		features: keyTableFeatures,
		data: enrollmentKeys,
		columns: keyColumns,
		meta,
		getRowId: (key) => key.id,
	});
	return <DataTable table={table} label={m.enrollment_keys()} />;
}

function CreateEnrollmentKeyDialog({
	open,
	pending,
	error,
	onClose,
	onCreate,
}: {
	open: boolean;
	pending: boolean;
	error: string;
	onClose: () => void;
	onCreate: (values: {
		name: string;
		labels: string[];
		maxNodes: number | null;
		expiresAt: string | null;
	}) => Promise<boolean>;
}) {
	const [name, setName] = useState("");
	const [labels, setLabels] = useState("");
	const [maxNodes, setMaxNodes] = useState("");
	// Expiry is a number of days from now; empty means the key never expires.
	const [expires, setExpires] = useState("");
	const expiresAt = expires
		? new Date(Date.now() + Number(expires) * 86_400_000)
		: null;
	useEffect(() => {
		if (!open) {
			setName("");
			setLabels("");
			setMaxNodes("");
			setExpires("");
		}
	}, [open]);
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !pending) onClose();
			}}
		>
			<DialogContent className="sm:max-w-md" showCloseButton={!pending}>
				<form
					method="post"
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void onCreate({
							name: name.trim(),
							labels: labels
								.split(",")
								.map((label) => label.trim())
								.filter(Boolean),
							maxNodes: maxNodes ? Number(maxNodes) : null,
							expiresAt: expiresAt?.toISOString() ?? null,
						});
					}}
				>
					<DialogHeader>
						<DialogTitle>{m.enrollment_key_create()}</DialogTitle>
					</DialogHeader>
					<div className="flex flex-col gap-2">
						<Label htmlFor="enrollment-key-name">{m.name()}</Label>
						<Input
							id="enrollment-key-name"
							value={name}
							required
							maxLength={120}
							placeholder="prod-linux"
							disabled={pending}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="enrollment-key-labels">
							{m.enrollment_key_labels()}
						</Label>
						<Input
							id="enrollment-key-labels"
							value={labels}
							placeholder="production, linux"
							disabled={pending}
							aria-describedby="enrollment-key-labels-help"
							onChange={(event) => setLabels(event.target.value)}
						/>
						<p
							id="enrollment-key-labels-help"
							className="text-xs text-muted-foreground"
						>
							{m.enrollment_key_labels_help()}
						</p>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="flex flex-col gap-2">
							<Label htmlFor="enrollment-key-limit">
								{m.enrollment_key_max_nodes()}
							</Label>
							<Input
								id="enrollment-key-limit"
								type="number"
								min={1}
								value={maxNodes}
								disabled={pending}
								aria-describedby="enrollment-key-limit-help"
								onChange={(event) => setMaxNodes(event.target.value)}
							/>
							<p
								id="enrollment-key-limit-help"
								className="text-xs text-muted-foreground"
							>
								{m.enrollment_key_max_nodes_help()}
							</p>
						</div>
						<div className="flex flex-col gap-2">
							<Label htmlFor="enrollment-key-expires">
								{m.enrollment_key_expires()}
							</Label>
							<NativeSelect
								id="enrollment-key-expires"
								value={expires}
								disabled={pending}
								aria-describedby="enrollment-key-expires-help"
								onChange={(event) => setExpires(event.target.value)}
							>
								<NativeSelectOption value="">
									{m.enrollment_key_never_expires()}
								</NativeSelectOption>
								<NativeSelectOption value="1">
									{m.enrollment_key_expiry_day()}
								</NativeSelectOption>
								{[7, 30, 90].map((days) => (
									<NativeSelectOption key={days} value={String(days)}>
										{m.enrollment_key_expiry_days({ count: days })}
									</NativeSelectOption>
								))}
								<NativeSelectOption value="365">
									{m.enrollment_key_expiry_year()}
								</NativeSelectOption>
							</NativeSelect>
							<p
								id="enrollment-key-expires-help"
								className="text-xs text-muted-foreground"
							>
								{expiresAt
									? m.enrollment_key_expires_on({
											date: new Intl.DateTimeFormat(getLocale(), {
												dateStyle: "medium",
											}).format(expiresAt),
										})
									: m.enrollment_key_no_expiry_help()}
							</p>
						</div>
					</div>
					<FormFeedback message={error} kind="error" reserveLine={false} />
					<DialogActions
						cancel={{ label: m.cancel(), disabled: pending, onClick: onClose }}
					>
						<Button
							type="submit"
							disabled={pending || !name.trim()}
							pending={pending}
						>
							{m.enrollment_key_create()}
						</Button>
					</DialogActions>
				</form>
			</DialogContent>
		</Dialog>
	);
}

// Commands stay untranslated; they never contain the key, which is pasted into the file.
const SAVE_KEY_COMMAND = `sudo install -d -m 0700 /etc/recount-collector
sudo sh -c 'umask 077; cat > /etc/recount-collector/enrollment.key'`;

function runCommand(origin: string) {
	return `sudo env \\
  RECOUNT_COLLECTOR_ENROLLMENT_URL=${origin} \\
  RECOUNT_COLLECTOR_ENROLLMENT_KEY_FILE=/etc/recount-collector/enrollment.key \\
  RECOUNT_COLLECTOR_STATE_DIRECTORY=/var/lib/recount-collector/node \\
  RECOUNT_COLLECTOR_QUEUE_DIRECTORY=/var/lib/recount-collector \\
  OTEL_EXPORTER_OTLP_ENDPOINT=http://ingestion.internal:4317 \\
  RECOUNT_COLLECTOR_VISIBILITY=host \\
  recount-collector`;
}

// The reveal dialog only opens in the browser after a mutation.
function appOrigin() {
	return typeof window === "undefined" ? "" : window.location.origin;
}

function SetupCommand({ children }: { children: string }) {
	return (
		<pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs leading-relaxed select-all">
			<code>{children}</code>
		</pre>
	);
}

function RevealDialog({
	reveal,
	onClose,
}: {
	reveal: RevealedEnrollmentKey | null;
	onClose: () => void;
}) {
	const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
	return (
		<Dialog
			open={reveal !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
				onInteractOutside={(event) => event.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>{m.enrollment_key_created_title()}</DialogTitle>
					<DialogDescription>
						{m.enrollment_key_created_description()}
					</DialogDescription>
				</DialogHeader>
				<code className="block rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all select-all">
					{reveal?.key}
				</code>
				<section
					aria-labelledby="collector-setup-title"
					className="flex flex-col gap-2 text-sm"
				>
					<h3 id="collector-setup-title" className="font-medium">
						{m.collector_setup_title()}
					</h3>
					<p className="text-muted-foreground">{m.collector_setup_save()}</p>
					<SetupCommand>{SAVE_KEY_COMMAND}</SetupCommand>
					<p className="text-muted-foreground">{m.collector_setup_run()}</p>
					<SetupCommand>{runCommand(appOrigin())}</SetupCommand>
				</section>
				<CopyStatus state={copied} />
				<DialogActions cancel={{ label: m.done(), onClick: onClose }}>
					<Button
						onClick={async () => {
							try {
								await navigator.clipboard.writeText(reveal?.key ?? "");
								setCopied("copied");
							} catch {
								setCopied("failed");
							}
						}}
					>
						{copied === "copied" ? (
							<CheckIcon aria-hidden="true" />
						) : (
							<CopyIcon aria-hidden="true" />
						)}
						{copied === "copied"
							? m.settings_copied()
							: m.enrollment_key_copy()}
					</Button>
				</DialogActions>
			</DialogContent>
		</Dialog>
	);
}
