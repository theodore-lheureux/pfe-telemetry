import { m } from "@recount/i18n/messages";
import type { ReactNode } from "react";
import { useId } from "react";
import type { InsightPerson } from "../analytics/saved-insights";
import { UserAvatar } from "../components/identity-avatar";
import { TagInput } from "../components/tag-input";
import { TimeDisplay } from "../components/time-display";
import { Badge } from "../components/ui/badge";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import {
	type AnnotationInput,
	type DefinitionStatus,
	MAX_DEFINITION_DESCRIPTION,
} from "./contracts";
import {
	STATUS,
	STATUS_CHOICES,
	type StatusChoice,
	statusChoice,
} from "./labels";

/** A status badge; `quiet` leaves out the default, visible status, as lists do. */
export function StatusBadge({
	status,
	quiet = false,
}: {
	status: DefinitionStatus | null;
	quiet?: boolean;
}) {
	const choice = statusChoice(status);
	if (quiet && choice === "visible") return null;
	const { icon: Icon, label } = STATUS[choice];
	return (
		<Badge
			variant={choice === "verified" ? "secondary" : "outline"}
			className={choice === "verified" ? "gap-1 text-primary" : "gap-1"}
		>
			<Icon aria-hidden="true" />
			{label()}
		</Badge>
	);
}

/** A labelled fact on a definition page, with an optional explanation below it. */
export function Fact({
	label,
	children,
	hint,
}: {
	label: string;
	children: ReactNode;
	hint?: string;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
				{label}
			</dt>
			<dd className="flex flex-col gap-1 text-sm">
				<div className="min-w-0 break-words">{children}</div>
				{hint && <p className="text-xs text-muted-foreground italic">{hint}</p>}
			</dd>
		</div>
	);
}

export function PersonName({ person }: { person: InsightPerson | null }) {
	if (!person)
		return (
			<span className="text-muted-foreground italic">
				{m.definitions_no_owner()}
			</span>
		);
	return (
		<span className="flex items-center gap-2">
			<UserAvatar user={person} className="size-5" />
			<span className="truncate">{person.name || person.email}</span>
		</span>
	);
}

/** The description, or an invitation to add one, with when and by whom it last changed. */
export function DescriptionBlock({
	description,
	fallback,
	placeholder,
	updatedAt,
	updatedBy,
}: {
	description: string;
	/** Shown when members wrote nothing, such as the instrumentation's description. */
	fallback: string;
	placeholder: string;
	updatedAt: Date | null;
	updatedBy: InsightPerson | null;
}) {
	return (
		<Fact label={m.definitions_description_label()}>
			{description || fallback ? (
				<p className="whitespace-pre-line">{description || fallback}</p>
			) : (
				<p className="text-muted-foreground italic">{placeholder}</p>
			)}
			{updatedAt && (
				<p className="mt-1 text-xs text-muted-foreground">
					{m.definitions_last_modified()}{" "}
					<TimeDisplay value={updatedAt} mode="relative" />
					{updatedBy && ` · ${updatedBy.name || updatedBy.email}`}
				</p>
			)}
		</Fact>
	);
}

/** Verified, visible or hidden, with what the choice means. */
export function StatusField({
	value,
	kind,
	disabled,
	onChange,
}: {
	value: StatusChoice;
	kind: "metric" | "attribute";
	disabled: boolean;
	onChange: (value: StatusChoice) => void;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-sm font-medium">{m.definitions_status()}</span>
			<ToggleGroup
				type="single"
				variant="outline"
				spacing={0}
				className="self-start"
				value={value}
				disabled={disabled}
				aria-label={m.definitions_status()}
				onValueChange={(next) => {
					if (next) onChange(next as StatusChoice);
				}}
			>
				{STATUS_CHOICES.map((choice) => {
					const { icon: Icon, label } = STATUS[choice];
					return (
						<ToggleGroupItem
							key={choice}
							value={choice}
							className="gap-1.5 px-3"
						>
							<Icon aria-hidden="true" />
							{label()}
						</ToggleGroupItem>
					);
				})}
			</ToggleGroup>
			<p className="text-xs text-muted-foreground italic">
				{STATUS[value][kind]()}
			</p>
		</div>
	);
}

/** Description, tags and status: what members add to metrics and attributes alike. */
export function AnnotationFields({
	value,
	kind,
	placeholder,
	disabled,
	onChange,
	children,
}: {
	value: AnnotationInput;
	kind: "metric" | "attribute";
	placeholder: string;
	disabled: boolean;
	onChange: (value: AnnotationInput) => void;
	/** Fields shown between the description and the status, such as an owner. */
	children?: ReactNode;
}) {
	const id = useId();
	return (
		<>
			<div className="flex flex-col gap-1.5">
				<span className="text-sm font-medium">{m.tags()}</span>
				<TagInput
					tags={value.tags}
					label={m.tags()}
					disabled={disabled}
					onChange={(tags) => onChange({ ...value, tags })}
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${id}-description`}>
					{m.definitions_description_label()}
				</Label>
				<Textarea
					id={`${id}-description`}
					value={value.description}
					maxLength={MAX_DEFINITION_DESCRIPTION}
					rows={3}
					disabled={disabled}
					placeholder={placeholder}
					onChange={(event) =>
						onChange({ ...value, description: event.target.value })
					}
				/>
			</div>
			{children}
			<StatusField
				value={statusChoice(value.status)}
				kind={kind}
				disabled={disabled}
				onChange={(choice) =>
					onChange({ ...value, status: choice === "visible" ? null : choice })
				}
			/>
		</>
	);
}

/** A titled section below a definition's facts. */
export function PageSection({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-3 border-t pt-5">
			<div className="flex flex-col gap-0.5">
				<h2 className="text-base font-semibold">{title}</h2>
				{description && (
					<p className="text-sm text-muted-foreground">{description}</p>
				)}
			</div>
			{children}
		</section>
	);
}
