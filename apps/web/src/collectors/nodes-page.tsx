import { m } from "@recount/i18n/messages";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import { useHydrated } from "@tanstack/react-router";
import {
	type ColumnDef,
	type OnChangeFn,
	type RowSelectionState,
	rowSelectionFeature,
	tableFeatures,
	useTable,
} from "@tanstack/react-table";
import { SearchIcon, ServerIcon } from "lucide-react";
import { useRef, useState } from "react";
import { DataTable } from "../components/data-table";
import { AlertDialogActions } from "../components/dialog-actions";
import { FormFeedback } from "../components/form-feedback";
import { PageHeader } from "../components/page-header";
import { TimeDisplay } from "../components/time-display";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "../components/ui/input-group";
import { Label } from "../components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "../components/ui/native-select";
import { useMutationOwner } from "../components/use-mutation-owner";
import { IconEmptyState } from "../components/workspace";
import { operationMessage } from "../lib/operation-message";
import type { OperationResult } from "../lib/operation-result";
import type { ProjectSummary } from "../organizations/contracts";
import { deleteNodes, listNodes, revokeNodes } from "./collector.functions";
import type { NodePage, NodeStatus, NodeSummary } from "./contracts";

type Confirmation = {
	kind: "revoke-nodes" | "delete-nodes";
	nodeIds: string[];
};

/**
 * The project's nodes: every member can search and filter them, and admins can revoke
 * or delete the selected ones.
 */
export function NodesPage({
	project,
	userId,
	initialNodes,
}: {
	project: ProjectSummary;
	userId: string;
	initialNodes: NodePage;
}) {
	const hydrated = useHydrated();
	const { begin } = useMutationOwner(userId);
	const canManage = project.role === "admin";
	const reference = {
		organizationId: project.organizationId,
		projectId: project.id,
	};
	const [nodes, setNodes] = useState(initialNodes);
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState<NodeStatus>("active");
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
	const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
	// Focus returns to whichever control opened the confirmation.
	const confirmationTrigger = useRef<HTMLElement | null>(null);
	function openConfirmation(next: Confirmation) {
		confirmationTrigger.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		setConfirmation(next);
	}
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const requested = useRef(0);

	async function loadNodes(next: {
		query?: string;
		status?: NodeStatus;
		page?: number;
	}) {
		const ticket = ++requested.current;
		const result = await listNodes({
			data: {
				...reference,
				query: next.query ?? query,
				status: next.status ?? status,
				page: next.page ?? nodes.page,
			},
		});
		if (ticket !== requested.current) return;
		if (result.error) setError(operationMessage(result.error));
		else {
			setNodes(result.data);
			setRowSelection({});
		}
	}

	// Searching waits for typing to pause, so it does not send one request per key.
	const searchNodes = useDebouncedCallback(
		(value: string) => void loadNodes({ query: value, page: 1 }),
		{ wait: 250 },
	);

	async function mutate(
		action: (signal: AbortSignal) => Promise<OperationResult<unknown>>,
		done: string,
	) {
		const operation = begin(() => {
			setConfirmation(null);
			setPending(false);
		});
		if (!operation) return;
		setPending(true);
		setError("");
		try {
			const result = await action(operation.signal);
			if (!operation.current()) return;
			if (result.error) {
				setError(operationMessage(result.error));
				return;
			}
			await operation
				.refresh(done, m.your_change_was_saved_but_the_page_could_2())
				.catch(() => false);
			if (!operation.current()) return;
			setConfirmation(null);
			await loadNodes({});
		} finally {
			if (operation.current()) setPending(false);
			operation.finish();
		}
	}

	const pages = Math.max(1, Math.ceil(nodes.total / nodes.pageSize));
	const selected = Object.keys(rowSelection);
	const filtered = query !== "" || status !== "active";

	return (
		<section className="flex min-w-0 flex-col gap-5">
			<PageHeader
				icon={ServerIcon}
				title={m.nodes()}
				description={m.nodes_description()}
			/>
			<div className="flex flex-wrap items-center gap-3">
				<InputGroup className="w-full sm:max-w-xs">
					<InputGroupAddon>
						<SearchIcon aria-hidden="true" />
					</InputGroupAddon>
					<InputGroupInput
						type="search"
						value={query}
						disabled={!hydrated}
						onChange={(event) => {
							setQuery(event.target.value);
							searchNodes(event.target.value);
						}}
						aria-label={m.nodes_search()}
						placeholder={m.nodes_search()}
					/>
				</InputGroup>
				<Label htmlFor="node-status" className="sr-only">
					{m.node_status_filter()}
				</Label>
				<NativeSelect
					id="node-status"
					value={status}
					disabled={!hydrated}
					onChange={(event) => {
						const next = event.target.value as NodeStatus;
						setStatus(next);
						void loadNodes({ status: next, page: 1 });
					}}
				>
					<NativeSelectOption value="active">
						{m.node_status_active()}
					</NativeSelectOption>
					<NativeSelectOption value="revoked">
						{m.node_status_revoked()}
					</NativeSelectOption>
					<NativeSelectOption value="all">
						{m.node_status_all()}
					</NativeSelectOption>
				</NativeSelect>
				{canManage && selected.length > 0 && (
					<div className="flex items-center gap-2 sm:ml-auto">
						<span className="text-sm text-muted-foreground">
							{m.nodes_selected({ count: selected.length })}
						</span>
						<Button
							variant="outline"
							disabled={!hydrated || pending}
							onClick={() =>
								openConfirmation({
									kind: "revoke-nodes",
									nodeIds: selected,
								})
							}
						>
							{m.nodes_revoke()}
						</Button>
						<Button
							variant="destructive"
							disabled={!hydrated || pending}
							onClick={() =>
								openConfirmation({
									kind: "delete-nodes",
									nodeIds: selected,
								})
							}
						>
							{m.nodes_delete()}
						</Button>
					</div>
				)}
			</div>
			{nodes.total === 0 && !filtered ? (
				<IconEmptyState
					icon={<ServerIcon aria-hidden="true" />}
					title={m.nodes_empty_title()}
					description={m.nodes_empty_description()}
					heading="h3"
					className="bg-card"
				/>
			) : (
				<NodesTable
					nodes={nodes.nodes}
					canManage={canManage}
					rowSelection={rowSelection}
					onRowSelectionChange={setRowSelection}
					disabled={!hydrated}
				/>
			)}
			{nodes.total > 0 && (
				<div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
					<span>{m.nodes_total({ count: nodes.total })}</span>
					<div className="flex items-center gap-2">
						<span>{m.nodes_page({ page: nodes.page, pages })}</span>
						<Button
							variant="outline"
							size="sm"
							disabled={!hydrated || nodes.page <= 1}
							onClick={() => void loadNodes({ page: nodes.page - 1 })}
						>
							{m.page_previous()}
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={!hydrated || nodes.page >= pages}
							onClick={() => void loadNodes({ page: nodes.page + 1 })}
						>
							{m.page_next()}
						</Button>
					</div>
				</div>
			)}
			<FormFeedback message={error} kind="error" reserveLine={false} />
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
						{confirmation?.kind === "delete-nodes"
							? m.nodes_delete_title({ count: confirmation.nodeIds.length })
							: m.nodes_revoke_title({
									count: confirmation?.nodeIds.length ?? 0,
								})}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{confirmation?.kind === "delete-nodes"
							? m.nodes_delete_description()
							: m.nodes_revoke_description()}
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
								const data = { ...reference, nodeIds: confirmation.nodeIds };
								if (confirmation.kind === "delete-nodes")
									void mutate(
										(signal) => deleteNodes({ data, signal }),
										m.nodes_deleted_done(),
									);
								else
									void mutate(
										(signal) => revokeNodes({ data, signal }),
										m.nodes_revoked_done(),
									);
							}}
						>
							{confirmation?.kind === "delete-nodes"
								? m.nodes_delete()
								: m.nodes_revoke()}
						</Button>
					</AlertDialogActions>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}

const nodeTableFeatures = tableFeatures({ rowSelectionFeature });
// Column definitions stay stable so cells keep their elements (and focus) across renders;
// values that change per render arrive through the table's meta.
type NodeTableMeta = { disabled: boolean };
const nodeColumns: ColumnDef<typeof nodeTableFeatures, NodeSummary>[] = [
	{
		id: "select",
		meta: { className: "w-10" },
		header: ({ table }) => (
			<Checkbox
				checked={
					table.getIsAllPageRowsSelected() ||
					(table.getIsSomePageRowsSelected() && "indeterminate")
				}
				disabled={
					(table.options.meta as NodeTableMeta).disabled ||
					!table.getRowModel().rows.length
				}
				aria-label={m.nodes_select_page()}
				onCheckedChange={(value) =>
					table.toggleAllPageRowsSelected(value === true)
				}
			/>
		),
		cell: ({ row, table }) => (
			<Checkbox
				checked={row.getIsSelected()}
				disabled={(table.options.meta as NodeTableMeta).disabled}
				aria-label={m.nodes_select_one({ host: row.original.hostname })}
				onCheckedChange={(value) => row.toggleSelected(value === true)}
			/>
		),
	},
	{
		id: "host",
		header: () => m.node_host(),
		cell: ({ row }) => (
			<>
				<p className="font-medium">{row.original.hostname}</p>
				<p className="font-mono text-xs text-muted-foreground">
					{row.original.machineId}
				</p>
			</>
		),
	},
	{
		id: "labels",
		header: () => m.node_labels(),
		cell: ({ row }) => (
			<div className="flex flex-wrap gap-1">
				{row.original.labels.map((label) => (
					<Badge key={label} variant="outline">
						{label}
					</Badge>
				))}
			</div>
		),
	},
	{
		id: "enrollmentKey",
		header: () => m.node_enrollment_key(),
		cell: ({ row }) => row.original.enrollmentKeyName,
	},
	{
		id: "version",
		header: () => m.node_version(),
		cell: ({ row }) => (
			<span className="font-mono text-xs">
				{row.original.collectorVersion || "—"}
			</span>
		),
	},
	{
		id: "lastSeen",
		header: () => m.node_last_seen(),
		cell: ({ row }) => (
			<TimeDisplay value={row.original.lastSeenAt} mode="relative" />
		),
	},
	{
		id: "status",
		header: () => m.node_status(),
		cell: ({ row }) =>
			row.original.revokedAt ? (
				<span className="text-muted-foreground">{m.node_status_revoked()}</span>
			) : (
				<Badge
					variant="outline"
					className="border-green-600 text-green-700 dark:text-green-400"
				>
					{m.node_status_active()}
				</Badge>
			),
	},
];

// Readers see the same columns without the selection checkboxes.
const readColumns = nodeColumns.filter((column) => column.id !== "select");

function NodesTable({
	nodes,
	canManage,
	rowSelection,
	onRowSelectionChange,
	disabled,
}: {
	nodes: NodeSummary[];
	/** Without it, rows have no selection, since only admins revoke or delete nodes. */
	canManage: boolean;
	rowSelection: RowSelectionState;
	onRowSelectionChange: OnChangeFn<RowSelectionState>;
	disabled: boolean;
}) {
	const meta: NodeTableMeta = { disabled };
	const table = useTable({
		features: nodeTableFeatures,
		data: nodes,
		columns: canManage ? nodeColumns : readColumns,
		meta,
		getRowId: (node) => node.id,
		state: { rowSelection },
		onRowSelectionChange,
	});
	return (
		<DataTable table={table} label={m.nodes()} empty={m.nodes_no_match()} />
	);
}
