import type { CalculatedMetric } from "../analytics/calculated-metrics";
import type { DefinitionStatus, MetricBehavior } from "../analytics/contracts";
import type { InsightPerson } from "../analytics/saved-insights";
import type { ProjectReference } from "../organizations/contracts";

export type { DefinitionStatus };
export const DEFINITION_STATUSES = [
	"verified",
	"hidden",
] as const satisfies DefinitionStatus[];
export const MAX_DEFINITION_DESCRIPTION = 1000;
export const ATTRIBUTE_SCOPES = ["point", "resource"] as const;
export type AttributeScope = (typeof ATTRIBUTE_SCOPES)[number];

/** What members add to a metric or an attribute. */
export interface Annotation {
	/** The members' description; empty when none was written. */
	description: string;
	tags: string[];
	status: DefinitionStatus | null;
	/** When members last changed it, and who; null before any change. */
	updatedAt: Date | null;
	updatedBy: InsightPerson | null;
}

/** A collected metric with what members added to it. */
export interface MetricEntry extends Annotation {
	name: string;
	label?: string;
	calculated?: CalculatedMetric;
	kind: number;
	behavior: MetricBehavior;
	unit: string;
	/** The description the instrumentation sent. */
	collectedDescription: string;
	owner: InsightPerson | null;
	/** An attribute field the metric is usually broken down by. */
	defaultBreakdown: string | null;
	firstSeen: Date;
	lastSeen: Date;
}

/** An attribute key with what members added to it, across the metrics that carry it. */
export interface AttributeEntry extends Annotation {
	scope: AttributeScope;
	key: string;
	kind: number;
	lastSeen: Date;
	/** Metrics that carry the attribute, up to a bounded number. */
	metrics: string[];
	/** A recent value, when one was found; only listed for one metric's attributes. */
	example?: string | null;
}

/** A saved insight that charts a metric, with the dashboards that show it. */
export interface MetricInsight {
	id: string;
	name: string;
	description: string;
	createdBy: InsightPerson | null;
	updatedAt: Date;
	dashboards: { id: string; name: string }[];
}

export interface MetricDetail {
	metric: MetricEntry;
	attributes: AttributeEntry[];
	insights: MetricInsight[];
	/** People who can open the project, offered as owners. */
	people: InsightPerson[];
}

export interface AttributeDetail {
	attribute: AttributeEntry;
	/** Frequent recent values, most frequent first; null when they could not be read. */
	values: string[] | null;
	/** The metrics that carry the attribute, with what members added to them. */
	metrics: MetricEntry[];
}

export type MetricReference = ProjectReference & { metric: string };
export type AttributeReference = ProjectReference & {
	scope: AttributeScope;
	key: string;
};

export interface AnnotationInput {
	description: string;
	tags: string[];
	status: DefinitionStatus | null;
}

export type UpdateMetricInput = MetricReference &
	AnnotationInput & {
		ownerId: string | null;
		defaultBreakdown: string | null;
	};

export type UpdateAttributeInput = AttributeReference & AnnotationInput;
