import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { TagIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { attributeLabel } from "../analytics/metric-names";
import { FormFeedback } from "../components/form-feedback";
import { TimeDisplay } from "../components/time-display";
import { Badge } from "../components/ui/badge";
import { useAppMutation } from "../components/use-app-mutation";
import type { ProjectReference } from "../organizations/contracts";
import { SCOPE_LABEL } from "./attribute-columns";
import type {
	AnnotationInput,
	AttributeDetail,
	AttributeEntry,
	UpdateAttributeInput,
} from "./contracts";
import {
	AnnotationFields,
	DescriptionBlock,
	Fact,
	PageSection,
	StatusBadge,
} from "./definition-parts";
import { DefinitionShell } from "./definition-shell";
import { updateAttributeDefinition } from "./definitions.functions";
import { STATUS, statusChoice, valueTypeLabel } from "./labels";
import { MetricTable } from "./metric-table";

const annotationOf = (attribute: AttributeEntry): AnnotationInput => ({
	description: attribute.description,
	tags: attribute.tags,
	status: attribute.status,
});

/** One attribute, read first: what members say about it, its values and its metrics. */
export function AttributeDetailPage({
	userId,
	reference,
	canWrite,
	detail,
}: {
	userId: string;
	reference: ProjectReference;
	canWrite: boolean;
	detail: AttributeDetail;
}) {
	const { attribute, values, metrics } = detail;
	const formId = useId();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(() => annotationOf(attribute));
	const mutation = useAppMutation({
		userId,
		saved: m.definitions_saved(),
		transientNotice: true,
		save: (data: UpdateAttributeInput, signal) =>
			updateAttributeDefinition({ data, signal }),
	});
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const result = await mutation.submit({
			...reference,
			scope: attribute.scope,
			key: attribute.key,
			...draft,
			description: draft.description.trim(),
		});
		if (result && !result.error && (await result.refresh())) setEditing(false);
	};
	const saved = annotationOf(attribute);
	const changed =
		JSON.stringify({ ...draft, description: draft.description.trim() }) !==
		JSON.stringify(saved);

	return (
		<DefinitionShell
			back={(arrow) => (
				<Link
					to="/organizations/$organizationId/projects/$projectId/definitions/attributes"
					params={reference}
				>
					{arrow}
					{m.definitions_back_attributes()}
				</Link>
			)}
			icon={TagIcon}
			title={attributeLabel(attribute.key)}
			technicalName={attribute.key}
			canWrite={canWrite}
			editing={editing}
			formId={formId}
			pending={mutation.pending}
			changed={changed}
			onEdit={() => {
				mutation.clearMessage();
				setDraft(saved);
				setEditing(true);
			}}
			onCancel={() => setEditing(false)}
		>
			{editing ? (
				<form
					id={formId}
					className="flex max-w-3xl flex-col gap-5"
					onSubmit={(event) => void submit(event)}
				>
					<AnnotationFields
						value={draft}
						kind="attribute"
						placeholder={m.definitions_attribute_description_placeholder()}
						disabled={mutation.pending}
						onChange={setDraft}
					/>
					<FormFeedback
						message={mutation.message}
						kind={mutation.kind}
						reserveLine={false}
					/>
				</form>
			) : (
				<>
					<dl className="grid gap-5">
						<DescriptionBlock
							description={attribute.description}
							fallback=""
							placeholder={m.definitions_add_attribute_description()}
							updatedAt={attribute.updatedAt}
							updatedBy={attribute.updatedBy}
						/>
						<div className="grid gap-5 border-t pt-5 sm:grid-cols-2 lg:grid-cols-4">
							<Fact
								label={m.definitions_status()}
								hint={STATUS[statusChoice(attribute.status)].attribute()}
							>
								<StatusBadge status={attribute.status} />
							</Fact>
							<Fact label={m.definitions_scope()}>
								{SCOPE_LABEL[attribute.scope]()}
							</Fact>
							<Fact label={m.definitions_type()}>
								{valueTypeLabel(attribute.kind)}
							</Fact>
							<Fact label={m.definitions_last_seen()}>
								<TimeDisplay value={attribute.lastSeen} mode="relative" />
							</Fact>
						</div>
						{attribute.tags.length > 0 && (
							<Fact label={m.tags()}>
								<span className="flex flex-wrap gap-1">
									{attribute.tags.map((tag) => (
										<Badge key={tag} variant="outline">
											{tag}
										</Badge>
									))}
								</span>
							</Fact>
						)}
					</dl>
					<PageSection title={m.definitions_recent_values()}>
						{values?.length ? (
							<span className="flex flex-wrap gap-1.5">
								{values.map((value) => (
									<code
										key={value}
										className="rounded border bg-card px-1.5 py-0.5 text-xs"
									>
										{value}
									</code>
								))}
							</span>
						) : (
							<p className="text-sm text-muted-foreground">
								{values
									? m.definitions_no_recent_values()
									: m.definitions_values_unavailable()}
							</p>
						)}
					</PageSection>
					<PageSection title={m.definitions_carried_by()}>
						<MetricTable
							userId={userId}
							reference={reference}
							metrics={metrics}
							label={m.definitions_carried_by()}
						/>
					</PageSection>
				</>
			)}
		</DefinitionShell>
	);
}
