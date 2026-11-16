import { expect, test } from "bun:test";
import type { MetricDefinition } from "../../src/analytics/contracts";
import {
	attributePreview,
	metricPreview,
} from "../../src/analytics/picker-command";

const metric: MetricDefinition = {
	name: "recount.node.cpu.time",
	kind: 2,
	temporality: 2,
	monotonic: true,
	unit: "s",
	description: "Collected description",
	behavior: "counter",
	firstSeen: new Date(0),
	lastSeen: new Date(0),
};

test("metric previews prefer team notes, then translated built-in descriptions", () => {
	expect(metricPreview({ ...metric, note: "Team guidance" }).description).toBe(
		"Team guidance",
	);
	expect(metricPreview(metric).description).toContain(
		"CPU time the node spent in each mode",
	);
	const custom = metricPreview({ ...metric, name: "custom.metric" });
	expect(custom.title).toBe("custom.metric");
	expect(custom.definition).toEqual({ kind: "metric", name: "custom.metric" });
	expect(custom.description).toBe("Collected description");
	expect(custom.facts).toContainEqual({ label: "Unit", value: "seconds" });
});

test("attribute previews preserve technical identity and distinguish source from measurement", () => {
	const attribute = {
		metric: metric.name,
		scope: "resource" as const,
		key: "os.type",
		kind: 2,
		note: "Operating system family",
	};
	const preview = attributePreview(attribute);
	expect(preview.title).toBe("Operating system");
	expect(preview.definition).toEqual({ kind: "attribute", name: "os.type" });
	expect(preview.description).toBe(attribute.note);
	expect(preview.facts).toContainEqual({ label: "Type", value: "String" });
	expect(preview.facts).toContainEqual({
		label: "Applies to",
		value: "Source",
	});
	expect(
		attributePreview({ ...attribute, scope: "point" }).facts,
	).toContainEqual({ label: "Applies to", value: "Measurement" });
});
