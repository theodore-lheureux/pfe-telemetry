import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { ChartLineIcon, RadioIcon, TelescopeIcon } from "lucide-react";
import { useId, useState } from "react";
import { ActivityPage } from "../activity/activity-page";
import { calculationDraft } from "../analytics/calculated-draft";
import { CalculationSummary } from "../analytics/calculation-summary";
import { groupFieldLabel } from "../analytics/group-by-picker";
import { encodeDraft } from "../analytics/insight/draft";
import { metricLabel } from "../analytics/metric-names";
import { unitLabel } from "../analytics/metric-units";
import { TimeDisplay } from "../components/time-display";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useAppMutation } from "../components/use-app-mutation";
import type { ProjectReference } from "../organizations/contracts";
import { AttributeTable } from "./attribute-table";
import type { MetricDetail, UpdateMetricInput } from "./contracts";
import {
	DescriptionBlock,
	Fact,
	PageSection,
	PersonName,
	StatusBadge,
} from "./definition-parts";
import { DefinitionShell } from "./definition-shell";
import { updateMetricDefinition } from "./definitions.functions";
import { DeleteCalculatedMetric } from "./delete-calculated-metric";
import { exploreDraft, kindLabel, STATUS, statusChoice } from "./labels";
import { defaultDescription } from "./metric-columns";
import { type MetricDraft, MetricForm, metricDraft } from "./metric-form";
import { MetricInsights } from "./metric-insights";

const sameDraft = (left: MetricDraft, right: MetricDraft) =>
	JSON.stringify({ ...left, description: left.description.trim() }) ===
	JSON.stringify(right);

/**
 * One metric, read first: what members say about it, when it was seen, who owns it,
 * its attributes, the insights that chart it and its latest measurements.
 */
export function MetricDetailPage({
	userId,
	reference,
	canWrite,
	detail,
}: {
	userId: string;
	reference: ProjectReference;
	canWrite: boolean;
	detail: MetricDetail;
}) {
	const { metric, attributes, insights, people } = detail;
	const formId = useId();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(() => metricDraft(metric));
	const mutation = useAppMutation({
		userId,
		saved: m.definitions_saved(),
		transientNotice: true,
		save: (data: UpdateMetricInput, signal) =>
			updateMetricDefinition({ data, signal }),
	});
	const save = async () => {
		const result = await mutation.submit({
			...reference,
			metric: metric.name,
			...draft,
			description: draft.description.trim(),
		});
		if (result && !result.error && (await result.refresh())) setEditing(false);
	};
	const status = statusChoice(metric.status);

	return (
		<DefinitionShell
			back={(arrow) => (
				<Link
					to="/organizations/$organizationId/projects/$projectId/definitions"
					params={reference}
				>
					{arrow}
					{m.definitions_back()}
				</Link>
			)}
			icon={ChartLineIcon}
			title={metricLabel(metric.name, metric.label)}
			technicalName={metric.calculated ? undefined : metric.name}
			canWrite={canWrite}
			editing={editing}
			formId={formId}
			pending={mutation.pending}
			changed={!sameDraft(draft, metricDraft(metric))}
			onEdit={() => {
				mutation.clearMessage();
				setDraft(metricDraft(metric));
				setEditing(true);
			}}
			onCancel={() => setEditing(false)}
			actions={
				<>
					{!metric.calculated && (
						<Button asChild variant="outline">
							<Link
								to="/organizations/$organizationId/projects/$projectId/activity"
								params={reference}
								search={{ metric: metric.name }}
							>
								<RadioIcon aria-hidden="true" />
								{m.definitions_view_activity()}
							</Link>
						</Button>
					)}
					{metric.calculated && canWrite && (
						<Button asChild variant="outline">
							<Link
								to="/organizations/$organizationId/projects/$projectId/explore"
								params={reference}
								search={{
									calculated: metric.name,
									q: encodeDraft(calculationDraft(metric.calculated)),
								}}
							>
								{metric.calculated.builtIn
									? m.calculated_copy()
									: m.calculated_edit()}
							</Link>
						</Button>
					)}
					<Button asChild variant="outline">
						<Link
							to="/organizations/$organizationId/projects/$projectId/explore"
							params={reference}
							search={{ q: exploreDraft(metric) }}
						>
							<TelescopeIcon aria-hidden="true" />
							{m.definitions_open_explore()}
						</Link>
					</Button>
					{metric.calculated && !metric.calculated.builtIn && canWrite && (
						<DeleteCalculatedMetric
							userId={userId}
							reference={reference}
							definition={metric.calculated}
							used={insights.length > 0}
						/>
					)}
				</>
			}
		>
			{editing ? (
				<MetricForm
					id={formId}
					metric={metric}
					draft={draft}
					people={people}
					attributes={attributes}
					disabled={mutation.pending}
					feedback={{ message: mutation.message, kind: mutation.kind }}
					onChange={setDraft}
					onSubmit={() => void save()}
				/>
			) : (
				<>
					<dl className="grid gap-5">
						<DescriptionBlock
							description={metric.description}
							fallback={defaultDescription(metric)}
							placeholder={m.definitions_add_description()}
							updatedAt={metric.updatedAt}
							updatedBy={metric.updatedBy}
						/>
						<div className="grid gap-5 border-t pt-5 sm:grid-cols-2 lg:grid-cols-4">
							{!metric.calculated && (
								<>
									<Fact label={m.definitions_first_seen()}>
										<TimeDisplay value={metric.firstSeen} mode="relative" />
									</Fact>
									<Fact label={m.definitions_last_seen()}>
										<TimeDisplay value={metric.lastSeen} mode="relative" />
									</Fact>
								</>
							)}
							<Fact label={m.definitions_insights_using()}>
								{insights.length}
							</Fact>
							<Fact label={m.definitions_owner()}>
								<PersonName person={metric.owner} />
							</Fact>
							<Fact
								label={m.definitions_status()}
								hint={STATUS[status].metric()}
							>
								<StatusBadge status={metric.status} />
							</Fact>
							<Fact
								label={m.definitions_default_breakdown()}
								hint={m.definitions_default_breakdown_hint()}
							>
								{metric.defaultBreakdown ? (
									groupFieldLabel(metric.defaultBreakdown)
								) : (
									<span className="text-muted-foreground">—</span>
								)}
							</Fact>
							<Fact label={m.definitions_kind()}>{kindLabel(metric)}</Fact>
							<Fact label={m.definitions_unit()}>
								{unitLabel(metric.unit) || m.definitions_no_unit()}
							</Fact>
						</div>
						{metric.tags.length > 0 && (
							<Fact label={m.tags()}>
								<span className="flex flex-wrap gap-1">
									{metric.tags.map((tag) => (
										<Badge key={tag} variant="outline">
											{tag}
										</Badge>
									))}
								</span>
							</Fact>
						)}
					</dl>
					{metric.calculated && (
						<CalculationSummary
							definition={metric.calculated}
							reference={reference}
						/>
					)}
					<PageSection
						title={m.definitions_metric_attributes()}
						description={m.definitions_metric_attributes_description()}
					>
						<AttributeTable
							reference={reference}
							attributes={attributes}
							label={m.definitions_metric_attributes()}
							columns={{ metrics: false, lastSeen: false }}
						/>
					</PageSection>
					<PageSection title={m.definitions_metric_insights()}>
						<MetricInsights
							userId={userId}
							reference={reference}
							insights={insights}
						/>
					</PageSection>
					{!metric.calculated && (
						<PageSection
							title={m.definitions_recent_measurements()}
							description={m.definitions_recent_measurements_description()}
						>
							<ActivityPage
								mode="explorer"
								userId={userId}
								reference={reference}
								metric={metric.name}
								embedded
							/>
						</PageSection>
					)}
				</>
			)}
		</DefinitionShell>
	);
}
