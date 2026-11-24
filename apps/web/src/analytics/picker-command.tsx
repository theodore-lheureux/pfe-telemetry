import { m } from "@recount/i18n/messages";
import { useCommandState } from "cmdk";
import type { ReactNode } from "react";
import { Command, CommandInput, CommandList } from "../components/ui/command";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "../components/ui/hover-card";
import { kindLabel, valueTypeLabel } from "../definitions/labels";
import type { AttributeDefinition, MetricDefinition } from "./contracts";
import {
	type DefinitionKind,
	DefinitionSourceIcon,
} from "./definition-source-icon";
import { attributeLabel, metricDescription, metricLabel } from "./metric-names";
import { unitLabel } from "./metric-units";

export interface PickerPreview {
	title: string;
	definition?: { kind: DefinitionKind; name: string };
	description?: string;
	facts?: { label: string; value: string }[];
}

export function metricPreview(metric: MetricDefinition): PickerPreview {
	return {
		title: metricLabel(metric.name, metric.label),
		definition: { kind: "metric", name: metric.name },
		description:
			metric.note || metricDescription(metric.name) || metric.description,
		facts: [
			{ label: m.definitions_kind(), value: kindLabel(metric) },
			{ label: m.definitions_unit(), value: unitLabel(metric.unit) || "—" },
		],
	};
}

export function attributePreview(
	attribute: AttributeDefinition,
): PickerPreview {
	return {
		title: attributeLabel(attribute.key),
		definition: { kind: "attribute", name: attribute.key },
		description: attribute.note,
		facts: [
			{ label: m.definitions_type(), value: valueTypeLabel(attribute.kind) },
			{
				label: m.definitions_scope(),
				value:
					attribute.scope === "point"
						? m.definitions_scope_point()
						: m.definitions_scope_resource(),
			},
		],
	};
}

/**
 * Shows cmdk's active item beside the picker, so pointer, keyboard and search
 * share one preview without resizing the list.
 */
function ActivePreview({
	previews,
	children,
}: {
	previews: Map<string, PickerPreview>;
	children: ReactNode;
}) {
	const active = useCommandState((state) => state.value);
	const preview = previews.get(active);
	return (
		<HoverCard open={preview !== undefined}>
			<HoverCardTrigger asChild>{children}</HoverCardTrigger>
			{preview && (
				// Informational only: clicks pass through so the picker closes as usual.
				<HoverCardContent
					side="right"
					align="start"
					sideOffset={8}
					aria-hidden="true"
					className="pointer-events-none hidden w-60 p-3 sm:block"
				>
					<PreviewDetails preview={preview} />
				</HoverCardContent>
			)}
		</HoverCard>
	);
}

function PreviewDetails({ preview }: { preview: PickerPreview }) {
	return (
		<>
			<div className="flex items-center gap-2">
				{preview.definition && <DefinitionSourceIcon {...preview.definition} />}
				<p className="text-sm font-medium wrap-anywhere">{preview.title}</p>
			</div>
			{preview.description && (
				<p className="mt-3 text-sm whitespace-pre-wrap wrap-anywhere">
					{preview.description}
				</p>
			)}
			{preview.facts && (
				<dl className="mt-3 space-y-3 text-xs">
					{preview.facts.map((fact) => (
						<div key={fact.label}>
							<dt className="text-muted-foreground">{fact.label}</dt>
							<dd className="mt-1 wrap-anywhere">{fact.value}</dd>
						</div>
					))}
				</dl>
			)}
		</>
	);
}

export const PICKER_CONTENT_CLASS =
	"w-[min(40rem,calc(100vw-2rem))] max-h-(--radix-popover-content-available-height) overflow-y-auto p-0";

export function PickerCommand({
	search,
	previews,
	searchAction,
	outlined = false,
	current,
	children,
}: {
	search: string;
	/** The chosen item's value, highlighted and previewed when the list opens. */
	current?: string;
	previews?: Map<string, PickerPreview>;
	searchAction?: ReactNode;
	outlined?: boolean;
	children: ReactNode;
}) {
	return (
		<Command defaultValue={current}>
			<CommandInput
				placeholder={search}
				endAddon={searchAction}
				variant={outlined ? "outline" : "filled"}
			/>
			{previews ? (
				<ActivePreview previews={previews}>
					<CommandList>{children}</CommandList>
				</ActivePreview>
			) : (
				<CommandList>{children}</CommandList>
			)}
		</Command>
	);
}
