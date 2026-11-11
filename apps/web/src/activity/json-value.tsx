import { m } from "@recount/i18n/messages";
import { useMemo } from "react";
import { JsonView } from "react-json-view-lite";
import type { JsonValue } from "./contracts";

function collapsed() {
	return false;
}

function bounded(value: JsonValue) {
	let nodes = 2000,
		truncated = false;
	const visit = (entry: JsonValue, depth: number): JsonValue => {
		if (--nodes < 0 || depth > 16) {
			truncated = true;
			return "…";
		}
		if (typeof entry === "string" && entry.length > 4096) {
			truncated = true;
			return `${entry.slice(0, 4096)}…`;
		}
		if (Array.isArray(entry)) {
			if (entry.length > 100) truncated = true;
			return entry.slice(0, 100).map((child) => visit(child, depth + 1));
		}
		if (entry && typeof entry === "object") {
			const entries = Object.entries(entry);
			if (entries.length > 128) truncated = true;
			return Object.fromEntries(
				entries
					.slice(0, 128)
					.map(([key, child]) => [key, visit(child, depth + 1)]),
			);
		}
		return entry;
	};
	return {
		value: visit(value, 0),
		get truncated() {
			return truncated;
		},
	};
}

export function JsonValueView({
	value,
	name,
}: {
	value: JsonValue;
	name: string;
}) {
	const preview = useMemo(() => bounded(value), [value]);
	if (preview.value === null || typeof preview.value !== "object")
		return (
			<span
				className={
					typeof value === "string" ? "text-primary" : "text-foreground"
				}
			>
				{JSON.stringify(preview.value)}
				{preview.truncated && (
					<span className="mt-1 block font-sans text-[10px] text-muted-foreground">
						{m.activity_truncated()}
					</span>
				)}
			</span>
		);
	return (
		<div className="min-w-0">
			<JsonView
				data={preview.value}
				shouldExpandNode={collapsed}
				clickToExpandNode
				aria-label={m.activity_expand({ name })}
				style={{
					container: "font-mono text-[11px] leading-5 text-foreground",
					childFieldsContainer: "m-0 list-none border-l border-border/60 pl-3",
					basicChildStyle: "relative min-w-0 break-all",
					label: "text-muted-foreground",
					clickableLabel:
						"cursor-pointer rounded-sm focus-visible:ring-2 focus-visible:ring-ring",
					stringValue: "text-primary",
					numberValue: "text-foreground",
					booleanValue: "text-primary",
					nullValue: "italic text-muted-foreground",
					undefinedValue: "italic text-muted-foreground",
					otherValue: "text-foreground",
					punctuation: "text-muted-foreground",
					expandIcon:
						"inline-flex size-4 cursor-pointer items-center justify-center rounded-sm align-middle text-muted-foreground after:content-['▸'] focus-visible:ring-2 focus-visible:ring-ring",
					collapseIcon:
						"inline-flex size-4 cursor-pointer items-center justify-center rounded-sm align-middle text-muted-foreground after:content-['▾'] focus-visible:ring-2 focus-visible:ring-ring",
					collapsedContent: "text-muted-foreground after:content-['…']",
					stringifyStringValues: true,
					ariaLables: {
						expandJson: m.activity_expand_json(),
						collapseJson: m.activity_collapse_json(),
					},
				}}
			/>
			{preview.truncated && (
				<span className="mt-1 block font-sans text-[10px] text-muted-foreground">
					{m.activity_truncated()}
				</span>
			)}
		</div>
	);
}
