import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { m } from "@recount/i18n/messages";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { executionParticipant } from "../execution-participant";
import { insertPoints } from "../telemetry/fixture";
import { data, expect } from "./fixtures";
import { test } from "./telemetry";

const second = 1_000_000_000n;

const metrics = {
	cpu: {
		metric_name: "'process.cpu.time'",
		metric_kind: "toUInt8(2)",
		temporality: "toUInt8(2)",
		monotonic: "CAST(1, 'Nullable(UInt8)')",
		unit: "'s'",
	},
	memory: {
		metric_name: "'recount.process.memory.rss'",
		metric_kind: "toUInt8(1)",
		temporality: "toUInt8(0)",
		monotonic: "CAST(NULL, 'Nullable(UInt8)')",
		unit: "'By'",
	},
};

interface Run {
	key: string;
	name: string;
	version: string;
	parameters: Record<string, string>;
	/** Seconds after the first run's start. */
	offset: bigint;
	duration: bigint;
	memory: boolean;
}

/**
 * Three runs of one workload on one node: the tuned run overlaps the baseline, the
 * later one starts after both. Only the baseline records memory, and no run records
 * disk I/O.
 */
const RUNS: Run[] = [
	{
		key: "run:baseline",
		name: "Simulation baseline",
		version: "1.0",
		parameters: { input: "mesh-small", threads: "4" },
		offset: 0n,
		duration: 120n,
		memory: true,
	},
	{
		key: "run:tuned",
		name: "Simulation tuned",
		version: "1.1",
		parameters: { input: "mesh-small", threads: "8" },
		offset: 60n,
		duration: 90n,
		memory: false,
	},
	{
		key: "run:later",
		name: "Simulation later",
		version: "1.1",
		parameters: { input: "mesh-small", threads: "8" },
		offset: 600n,
		duration: 90n,
		memory: false,
	},
];

async function seed(
	telemetry: Parameters<Parameters<typeof test>[2]>[0]["telemetry"],
	project: string,
) {
	const node = randomUUID();
	const base = BigInt(Date.now() - 900_000) * 1_000_000n;
	for (const run of RUNS) {
		const start = base + run.offset * second;
		const end = start + run.duration * second;
		const resource = `process-${run.key}`;
		const lifecycle = executionParticipant(project, run.key, {
			nodeId: node,
			name: run.name,
			firstSeen: start,
		});
		await telemetry.client.insert({
			table: "execution_participants",
			format: "JSONEachRow",
			values: [
				{
					...lifecycle,
					environment_variable: "RECOUNT_EXECUTION",
					workload_version: run.version,
					parameters: Object.entries(run.parameters).map(([key, value]) => ({
						key,
						value,
					})),
					last_seen_unix_nano: end.toString(),
					owner_uid: 1000,
				},
				{
					...lifecycle,
					fact_id: randomUUID(),
					kind: 2,
					environment_variable: "RECOUNT_EXECUTION",
					process_resource_id: resource,
					process_namespace_id: "pidns:1",
					process_pid: 42,
					process_start_time_ticks: "100",
					execution_name: null,
					workload_version: null,
					parameters: [],
					last_seen_unix_nano: end.toString(),
				},
			],
		});
		const samples: [keyof typeof metrics, bigint, number][] = [];
		for (let at = 0n; at <= run.duration; at += 10n) {
			samples.push(["cpu", at, Number(at) * (run.key === "run:tuned" ? 2 : 1)]);
			if (run.memory)
				samples.push(["memory", at, 1_048_576 * (1 + Number(at) / 30)]);
		}
		for (const [metric, at, value] of samples)
			await telemetry.client.command({
				query: insertPoints({
					resource_id: "{resource:String}",
					resource_kind: "toUInt8(4)",
					...metrics[metric],
				}),
				query_params: {
					project,
					source: node,
					host: node,
					resource,
					time: (start + at * second).toString(),
					integer: String(Math.round(value)),
					sample: randomUUID(),
					stream: `${resource}/${metric}`,
					epoch: "epoch",
				},
			});
	}
}

const picker = (page: Page, label: string) =>
	page.getByRole("combobox", { name: new RegExp(`^${label}:`) });

async function choose(page: Page, label: string, search: string, key: string) {
	await picker(page, label).click();
	await page.getByPlaceholder(m.execution_compare_search()).fill(search);
	await page.getByRole("option", { name: new RegExp(key) }).click();
}

const card = (page: Page, measurement: string): Locator =>
	page.locator(`[data-measurement="${measurement}"]`);

test("two executions compare their context and aligned measurements", async ({
	page,
	workspace,
	telemetry,
}) => {
	const actor = await workspace.signIn(
		page,
		`execution-compare-${randomUUID()}@example.invalid`,
	);
	const organization = data(
		await workspace.operations(actor.headers, () =>
			createOrganization(workspace.auth, actor.headers, {
				name: "Comparisons",
				slug: `comparisons-${randomUUID()}`,
			}),
		),
	);
	const project = data(
		await workspace.operations(actor.headers, (actor) =>
			createProject(workspace.database.db, actor, {
				requestId: randomUUID(),
				organizationId: organization.id,
				name: "Workloads",
			}),
		),
	);
	await seed(telemetry, project.id);
	const path = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}`;
	await page.goto(`${path}/executions`);
	await page
		.getByRole("navigation", { name: m.project_navigation() })
		.getByRole("link", { name: m.execution_compare_nav() })
		.click();
	await expect(page).toHaveURL(/\/compare$/);
	await expect(
		page.getByRole("heading", { name: m.execution_compare_empty_title() }),
	).toBeVisible();

	// The first execution is picked with the keyboard, searched by its name.
	const first = page.getByRole("combobox", {
		name: `${m.execution_compare_first()}: ${m.execution_compare_choose()}`,
	});
	await first.focus();
	await expect(first).toBeFocused();
	await page.keyboard.press("Enter");
	await page.keyboard.type("baseline");
	await expect(page.getByRole("option")).toHaveCount(1);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/[?&]a=run%3Abaseline/);
	await expect(picker(page, m.execution_compare_first())).toHaveAccessibleName(
		`${m.execution_compare_first()}: Simulation baseline`,
	);
	await expect(page.getByRole("option")).toHaveCount(0);
	// The other side cannot pick the same execution; it is searched by key.
	await picker(page, m.execution_compare_second()).click();
	await expect(
		page.getByRole("option", { name: /run:baseline/ }),
	).toHaveAttribute("aria-disabled", "true");
	await page.getByPlaceholder(m.execution_compare_search()).fill("run:tuned");
	await page.getByRole("option", { name: /run:tuned/ }).click();
	await expect(page).toHaveURL(/[?&]b=run%3Atuned/);

	const timing = page.getByRole("alert").filter({
		hasText: m.execution_compare_not_causation(),
	});
	await expect(timing).toContainText(
		m.execution_compare_concurrent({ duration: "1 min" }),
	);
	await expect(timing).toContainText(
		m.execution_compare_shared_nodes({ count: "1" }),
	);

	const context = page.getByRole("table");
	const row = (name: string | RegExp) => context.getByRole("row", { name });
	await expect(row(/^Workload version/)).toContainText(
		m.execution_compare_differs(),
	);
	await expect(row(/^Parameter threads/)).toContainText(
		m.execution_compare_differs(),
	);
	await expect(row(/^Parameter input/)).not.toContainText(
		m.execution_compare_differs(),
	);
	await expect(page.getByText(m.execution_compare_unrecorded())).toBeVisible();
	await expect(row(/^Duration/)).toContainText("2 min");
	await expect(row(/^Duration/)).toContainText("1 min 30 sec");
	await expect(row(/^Owner UIDs/)).toContainText("1000");

	await expect(card(page, "cpu")).toHaveAttribute("data-status", "comparable");
	await expect(
		card(page, "cpu").getByRole("img", {
			name: m.execution_compare_chart_label({
				measurement: m.execution_compare_cpu(),
			}),
		}),
	).toBeVisible();
	// The baseline uses one core and the tuned run two, whatever their start times.
	await expect(card(page, "cpu")).toContainText(
		m.execution_compare_summary({ average: "1", peak: "1" }),
	);
	await expect(card(page, "cpu")).toContainText(
		m.execution_compare_summary({ average: "2", peak: "2" }),
	);
	await expect(card(page, "memory")).toHaveAttribute(
		"data-status",
		"incomparable",
	);
	await expect(card(page, "memory")).toContainText(
		m.execution_compare_incomparable_description({
			execution: "Simulation tuned",
		}),
	);
	await expect(card(page, "io")).toHaveAttribute("data-status", "unavailable");
	await expect(card(page, "io")).toContainText(
		m.execution_compare_unavailable_project(),
	);

	await page.getByRole("button", { name: m.execution_compare_swap() }).click();
	await expect(page).toHaveURL(/a=run%3Atuned&b=run%3Abaseline/);
	await choose(page, m.execution_compare_second(), "later", "run:later");
	await expect(page.getByRole("alert")).toContainText(
		m.execution_compare_isolated(),
	);
	await expect(page.getByRole("alert")).not.toContainText(
		m.execution_compare_not_causation(),
	);

	await page.goto(`${path}/compare?a=run%3Abaseline&b=run%3Abaseline`);
	await expect(picker(page, m.execution_compare_second())).toHaveAccessibleName(
		`${m.execution_compare_second()}: ${m.execution_compare_choose()}`,
	);
	await expect(
		page.getByRole("heading", { name: m.execution_compare_empty_title() }),
	).toBeVisible();
	await page.goto(`${path}/compare?a=run%3Abaseline&b=run%3Amissing`);
	await expect(
		page.getByRole("alert").filter({ hasText: m.execution_compare_missing() }),
	).toContainText("run:missing");
	await expect(picker(page, m.execution_compare_first())).toHaveAccessibleName(
		`${m.execution_compare_first()}: Simulation baseline`,
	);

	await page
		.context()
		.addCookies([
			{ name: "recount_locale", value: "fr", url: workspace.origin },
		]);
	await page.goto(`${path}/compare?a=run%3Abaseline&b=run%3Atuned`);
	const fr = { locale: "fr" } as const;
	await expect(
		page.getByRole("heading", { name: m.execution_compare_title({}, fr) }),
	).toBeVisible();
	await expect(card(page, "memory")).toContainText(
		m.execution_compare_incomparable({}, fr),
	);
	await expect(page.getByRole("alert")).toContainText(
		m.execution_compare_not_causation({}, fr),
	);
});
