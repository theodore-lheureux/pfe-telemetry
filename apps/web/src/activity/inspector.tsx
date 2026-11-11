import { m } from "@recount/i18n/messages";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, SearchIcon } from "lucide-react";
import { type CSSProperties, useId, useState } from "react";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../components/ui/tabs";
import { unwrapOperation } from "../lib/operation-result";
import type { ProjectReference } from "../organizations/contracts";
import { getActivityPacket, getActivityPoint } from "./activity.functions";
import type {
	JsonObject,
	JsonValue,
	PacketSummary,
	PointSummary,
} from "./contracts";
import { JsonValueView } from "./json-value";

function isObject(value: JsonValue): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function kind(value: JsonValue): string {
	return value === null
		? "NULL"
		: Array.isArray(value)
			? "ARRAY"
			: typeof value === "object"
				? "OBJECT"
				: typeof value === "number"
					? "NUMBER"
					: typeof value === "boolean"
						? "BOOLEAN"
						: "STRING";
}

function CopyValue({
	name,
	value,
	label,
}: {
	name: string;
	value: JsonValue;
	label?: string;
}) {
	const [copied, setCopied] = useState(false),
		[failed, setFailed] = useState(false);
	return (
		<span className="inline-flex shrink-0 items-center gap-2">
			{failed && (
				<span role="alert" className="text-xs text-destructive">
					{m.activity_copy_failed()}
				</span>
			)}
			<Button
				type="button"
				variant={label ? "outline" : "ghost"}
				size={label ? "sm" : "icon-xs"}
				// Per-property copy stays out of the way until the row is hovered or focused.
				className={
					label
						? undefined
						: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
				}
				aria-label={label ? undefined : m.activity_copy({ name })}
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(
							typeof value === "string"
								? value
								: JSON.stringify(value, null, 2),
						);
						setCopied(true);
						setFailed(false);
					} catch {
						setFailed(true);
					}
				}}
			>
				{copied ? (
					<CheckIcon aria-hidden="true" />
				) : (
					<CopyIcon aria-hidden="true" />
				)}
				{label}
			</Button>
		</span>
	);
}

function PropertyViewer({
	value,
	attributes = false,
}: {
	value: JsonValue;
	attributes?: boolean;
}) {
	const hideNullId = useId();
	const [search, setSearch] = useState(""),
		[hideNull, setHideNull] = useState(true);
	const entries: { key: string; value: JsonValue; type?: string }[] =
		attributes && Array.isArray(value)
			? value.map((entry, index) => {
					const node = isObject(entry) ? entry : {},
						type = Number(node.kind ?? 0);
					const field = (
						{
							2: "string_value",
							3: "int_value",
							4: "double_value",
							5: "bool_value",
							6: "bytes_value",
						} as Record<number, string>
					)[type];
					const selected = field ? (node[field] ?? null) : entry;
					return {
						key: String(node.path ?? index),
						value:
							type === 5 && selected !== null ? Boolean(selected) : selected,
						type: (
							{
								0: "ABSENT",
								1: "EMPTY",
								2: "STRING",
								3: "INTEGER",
								4: "DOUBLE",
								5: "BOOLEAN",
								6: "BYTES",
								7: "ARRAY",
								8: "KEY_VALUE_LIST",
							} as Record<number, string>
						)[type],
					};
				})
			: value && typeof value === "object"
				? Object.entries(value).map(([key, entry]) => ({ key, value: entry }))
				: [{ key: "value", value }];
	const needle = search.toLocaleLowerCase();
	const visible = entries.filter(
		(entry) =>
			(!hideNull || entry.value !== null) &&
			(!needle ||
				entry.key.toLocaleLowerCase().includes(needle) ||
				JSON.stringify(entry.value).toLocaleLowerCase().includes(needle)),
	);
	return (
		<div className="flex min-w-0 flex-col gap-3 p-3">
			<div className="flex flex-wrap items-center gap-3">
				<div className="relative w-full max-w-sm">
					<SearchIcon
						aria-hidden="true"
						className="absolute top-1.5 left-2 size-3.5 text-muted-foreground"
					/>
					<Input
						className="h-7 pl-7 text-xs"
						aria-label={m.activity_property_search()}
						placeholder={m.activity_property_search()}
						value={search}
						onChange={(event) => setSearch(event.currentTarget.value)}
					/>
				</div>
				<label htmlFor={hideNullId} className="flex items-center gap-2 text-xs">
					<Checkbox
						id={hideNullId}
						checked={hideNull}
						onCheckedChange={(value) => setHideNull(value === true)}
					/>
					{m.activity_hide_null()}
				</label>
			</div>
			<div
				className="divide-y rounded-md border bg-background"
				// Tide sizes buttons from the control height; keep copy buttons within a text line.
				style={{ "--control-height": "20px" } as CSSProperties}
			>
				{visible.map((entry) => (
					<div
						key={entry.key}
						// A lone nested object reads better as one full-width tree.
						className={`group grid min-w-0 grid-cols-1 gap-x-4 px-3 py-1.5 ${
							visible.length === 1 && isObject(entry.value)
								? ""
								: "sm:grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)]"
						}`}
					>
						<span
							className="break-all font-mono text-xs leading-5 text-muted-foreground"
							title={entry.type ?? kind(entry.value)}
						>
							{entry.key}
						</span>
						<div className="flex min-w-0 items-start gap-1 break-all font-mono text-xs leading-5">
							<JsonValueView value={entry.value} name={entry.key} />
							<CopyValue name={entry.key} value={entry.value} />
						</div>
					</div>
				))}
				{!visible.length && (
					<p className="px-3 py-4 text-sm text-muted-foreground">
						{m.activity_no_properties()}
					</p>
				)}
			</div>
		</div>
	);
}

export function ActivityInspector({
	userId,
	reference,
	point,
	packet,
}: {
	userId: string;
	reference: ProjectReference;
	point?: PointSummary;
	packet?: PacketSummary;
}) {
	const details = useQuery({
		queryKey: [
			"activity-detail",
			userId,
			reference.organizationId,
			reference.projectId,
			point?.sampleId ?? packet?.id,
		],
		queryFn: async ({ signal }) =>
			point
				? {
						point: unwrapOperation(
							await getActivityPoint({
								data: { ...reference, ...point },
								signal,
							}),
						),
					}
				: {
						packet: unwrapOperation(
							await getActivityPacket({
								data: {
									...reference,
									packetId: packet?.id ?? "",
									partition: packet?.partition ?? 0,
									offset: packet?.offset ?? "0",
								},
								signal,
							}),
						),
					},
		retry: false,
		staleTime: Infinity,
		gcTime: 0,
		refetchOnWindowFocus: false,
	});
	if (details.isPending)
		return (
			<p role="status" className="p-4 text-muted-foreground">
				{m.activity_loading()}
			</p>
		);
	if (details.isError)
		return (
			<div className="space-y-2 p-4">
				<p role="alert">
					{packet ? m.activity_detail_expired() : m.activity_unavailable()}
				</p>
				<Button variant="outline" onClick={() => void details.refetch()}>
					{m.activity_retry()}
				</Button>
			</div>
		);
	const stored = details.data.point,
		incoming = details.data.packet;
	const tabs: {
		id: string;
		title: string;
		value: JsonValue;
		attributes?: boolean;
		note?: string;
	}[] = stored
		? [
				{
					id: "measurement",
					title: m.activity_measurement(),
					value: stored.measurement,
				},
				{
					id: "attributes",
					title: m.activity_attributes(),
					value: stored.attributes,
					attributes: true,
				},
				{
					id: "resource",
					title: m.activity_resource(),
					value: stored.resource,
				},
				{
					id: "instrumentation",
					title: m.activity_instrumentation(),
					value: stored.instrumentation,
				},
				{
					id: "diagnostics",
					title: m.activity_diagnostics(),
					value: stored.provenance.delivery ?? {},
				},
				{
					id: "provenance",
					title: m.activity_provenance(),
					value: stored.provenance,
				},
				{
					id: "json",
					title: m.activity_json(),
					value: stored.raw,
				},
			]
		: incoming
			? [
					{
						id: "diagnostics",
						title: m.activity_diagnostics(),
						value: incoming.delivery,
					},
					{
						id: "metadata",
						title: m.activity_metadata(),
						value: incoming.metadata,
					},
					{
						id: "payload",
						title: m.activity_payload(),
						value: incoming.payload,
						note: incoming.truncated ? m.activity_truncated() : undefined,
					},
				]
			: [];
	return (
		// The row above already names the point, node and time; the bar holds only tabs and copy.
		<Tabs defaultValue={tabs[0]?.id} className="gap-0">
			<div className="flex items-center justify-between gap-3 border-b pr-3">
				<TabsList
					aria-label={m.activity_details()}
					className="min-w-0 border-b-0 px-3"
				>
					{tabs.map((tab) => (
						<TabsTrigger key={tab.id} value={tab.id}>
							{tab.title}
						</TabsTrigger>
					))}
				</TabsList>
				<CopyValue
					name={m.activity_json()}
					value={stored ? stored.raw : (incoming?.payload ?? {})}
					label={m.activity_copy_json()}
				/>
			</div>
			{tabs.map((tab) => (
				<TabsContent key={tab.id} value={tab.id}>
					{tab.note && (
						<p className="px-4 pb-4 text-xs leading-5 text-muted-foreground">
							{tab.note}
						</p>
					)}
					<PropertyViewer value={tab.value} attributes={tab.attributes} />
				</TabsContent>
			))}
		</Tabs>
	);
}
