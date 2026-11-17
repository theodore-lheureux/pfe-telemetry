import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { createOrganization } from "../../src/organizations/organizations.server";
import {
	createProject,
	setProjectMember,
} from "../../src/organizations/projects.server";
import { createTestNode } from "../collector-node";
import { executionParticipant } from "../execution-participant";
import { insertPoints } from "../telemetry/fixture";
import { data, expect } from "./fixtures";
import { test } from "./telemetry-fixtures";

const second = 1_000_000_000n;
type Telemetry = Parameters<Parameters<typeof test>[2]>[0]["telemetry"];
type Workspace = Parameters<Parameters<typeof test>[2]>[0]["workspace"];

function participant(
	project: string,
	key: string,
	node: string,
	start: bigint,
	end: bigint,
	process?: string,
	name?: string,
) {
	const base = {
		...executionParticipant(project, key, {
			nodeId: node,
			firstSeen: start,
			name,
		}),
		last_seen_unix_nano: end.toString(),
	};
	if (!process) return base;
	return {
		...base,
		kind: 2,
		process_resource_id: process,
		process_namespace_id: "pidns:1",
		process_pid: 42,
		process_start_time_ticks: "100",
		execution_name: null,
		workload_version: null,
		parameters: [],
	};
}

/** Cumulative CPU time and resident memory every 10 s from `start` to `end`. */
async function processLoad(
	telemetry: Telemetry,
	project: string,
	node: string,
	process: string,
	[start, end]: [bigint, bigint],
	cores: number,
	bytes: number,
) {
	for (let at = start, step = 0; at <= end; at += 10n * second, step++)
		for (const [metric, kind, temporality, unit, value] of [
			["process.cpu.time", 2, 2, "s", Math.round(step * 10 * cores)],
			["recount.process.memory.rss", 1, 0, "By", bytes],
		] as const)
			await telemetry.client.command({
				query: insertPoints({
					resource_id: "{resource:String}",
					resource_kind: "toUInt8(4)",
					metric_name: `'${metric}'`,
					metric_kind: `toUInt8(${kind})`,
					temporality: `toUInt8(${temporality})`,
					monotonic:
						kind === 2
							? "CAST(1, 'Nullable(UInt8)')"
							: "CAST(NULL, 'Nullable(UInt8)')",
					unit: `'${unit}'`,
				}),
				query_params: {
					project,
					source: node,
					host: node,
					resource: process,
					time: at.toString(),
					integer: String(value),
					sample: randomUUID(),
					stream: `${process}/${metric}`,
					epoch: "epoch",
				},
			});
}

async function scenario(
	workspace: Workspace,
	telemetry: Telemetry,
	page: Page,
) {
	const owner = await workspace.signIn(
		page,
		`overlap-owner-${randomUUID()}@example.invalid`,
	);
	const organization = data(
		await workspace.operations(owner.headers, () =>
			createOrganization(workspace.auth, owner.headers, {
				name: "Shared cluster",
				slug: `shared-cluster-${randomUUID()}`,
			}),
		),
	);
	const create = (name: string) =>
		workspace.operations(owner.headers, (actor) =>
			createProject(workspace.database.db, actor, {
				requestId: randomUUID(),
				organizationId: organization.id,
				name,
			}),
		);
	const project = data(await create("Training"));
	const foreign = data(await create("Other team"));
	const reference = { organizationId: organization.id, projectId: project.id };
	const { nodeId: node } = await createTestNode(
		workspace.database.db,
		reference,
		{ hostname: "gpu-07" },
	);
	const lonely = randomUUID();
	const start = BigInt(Date.now() - 12 * 60_000) * 1_000_000n;
	const minute = 60n * second;
	const end = start + 10n * minute;
	const neighbour: [bigint, bigint] = [
		start + 3n * minute,
		start + 8n * minute,
	];
	await telemetry.client.insert({
		table: "execution_participants",
		format: "JSONEachRow",
		values: [
			participant(
				project.id,
				"run:selected",
				node,
				start,
				end,
				undefined,
				"Training run",
			),
			participant(project.id, "run:selected", node, start, end, "p-selected"),
			participant(
				project.id,
				"run:neighbour",
				node,
				...neighbour,
				undefined,
				"Neighbour job",
			),
			participant(
				project.id,
				"run:neighbour",
				node,
				...neighbour,
				"p-neighbour",
			),
			participant(
				project.id,
				"run:alone",
				lonely,
				start,
				end,
				undefined,
				"Lonely run",
			),
			// Another project's workload on the same node and time stays invisible.
			participant(
				foreign.id,
				"run:foreign",
				node,
				start,
				end,
				undefined,
				"Foreign job",
			),
			participant(foreign.id, "run:selected", node, start, end, "p-free"),
		],
	});
	await processLoad(
		telemetry,
		project.id,
		node,
		"p-selected",
		[start, end],
		1.5,
		2 ** 31,
	);
	await processLoad(
		telemetry,
		project.id,
		node,
		"p-neighbour",
		neighbour,
		0.5,
		2 ** 29,
	);
	await processLoad(
		telemetry,
		project.id,
		node,
		"p-free",
		[start, end],
		0.3,
		2 ** 28,
	);
	await processLoad(
		telemetry,
		foreign.id,
		node,
		"p-free",
		[start, end],
		8,
		2 ** 34,
	);
	return {
		owner,
		organization,
		project,
		path: `${workspace.origin}/organizations/${organization.id}/projects/${project.id}/executions`,
	};
}

async function expectOverlaps(page: Page) {
	const section = page.getByRole("region", {
		name: "Overlapping workloads",
		exact: true,
	});
	await expect(section).toContainText(
		"An overlap is context, not proof of causation.",
	);
	await expect(section).toContainText(
		"Workloads in other projects are never shown or counted",
	);
	const table = section.getByRole("table", {
		name: "Overlapping executions",
		exact: true,
	});
	await expect(table.getByRole("row")).toHaveCount(2);
	await expect(
		table.getByRole("link", { name: "Neighbour job" }),
	).toBeVisible();
	await expect(table).toContainText("gpu-07");
	await expect(section).not.toContainText("Foreign job");
	for (const name of ["CPU (busy cores)", "Resident memory"]) {
		const figure = section.getByRole("figure", { name, exact: true });
		await expect(figure.locator(".recharts-surface")).toBeVisible();
		await expect(figure).toContainText("This execution");
		await expect(figure).toContainText("Processes without an execution");
	}
	return section;
}

test("viewers and operators see the same project-scoped overlaps and load split", async ({
	page,
	browser,
	workspace,
	telemetry,
}, testInfo) => {
	const f = await scenario(workspace, telemetry, page);
	await page.goto(`${f.path}/run:selected`);
	const section = await expectOverlaps(page);
	const operatorRows = await section.getByRole("row").allInnerTexts();
	await page.screenshot({
		path: testInfo.outputPath("execution-overlaps-operator.png"),
		fullPage: true,
	});

	const viewerContext = await browser.newContext();
	try {
		const viewerPage = await viewerContext.newPage();
		const viewer = await workspace.signIn(
			viewerPage,
			`overlap-viewer-${randomUUID()}@example.invalid`,
		);
		const membership = await workspace.auth.api.addMember({
			body: {
				organizationId: f.organization.id,
				userId: viewer.userId,
				role: "member",
			},
		});
		data(
			await workspace.operations(f.owner.headers, (actor) =>
				setProjectMember(workspace.database.db, actor, {
					organizationId: f.organization.id,
					projectId: f.project.id,
					memberId: membership.id,
					role: "viewer",
				}),
			),
		);
		await viewerPage.goto(`${f.path}/run:selected`);
		const viewerSection = await expectOverlaps(viewerPage);
		expect(await viewerSection.getByRole("row").allInnerTexts()).toEqual(
			operatorRows,
		);
	} finally {
		await viewerContext.close();
	}

	await section.getByRole("link", { name: "Neighbour job" }).click();
	await expect(page).toHaveURL(/\/executions\/run(:|%3A)neighbour$/);
	await expect(
		page
			.getByRole("table", { name: "Overlapping executions", exact: true })
			.getByRole("link", { name: "Training run" }),
	).toBeVisible();

	await page
		.context()
		.addCookies([
			{ name: "recount_locale", value: "fr", url: workspace.origin },
		]);
	await page.goto(`${f.path}/run:selected`);
	const french = page.getByRole("region", {
		name: "Charges de travail simultanées",
		exact: true,
	});
	await expect(french).toContainText("pas la preuve d’une cause");
	await expect(
		french.getByRole("figure", { name: "Processeur (cœurs occupés)" }),
	).toContainText("Cette exécution");
});

test("an execution alone on its machines shows the empty state", async ({
	page,
	workspace,
	telemetry,
}) => {
	const f = await scenario(workspace, telemetry, page);
	await page.goto(`${f.path}/run:alone`);
	const section = page.getByRole("region", {
		name: "Overlapping workloads",
		exact: true,
	});
	await expect(
		section.getByRole("heading", {
			name: "No overlapping workloads on these machines",
		}),
	).toBeVisible();
	await expect(
		section.getByText(
			"No process measurements on these nodes while this execution was active.",
		),
	).toHaveCount(2);
});
