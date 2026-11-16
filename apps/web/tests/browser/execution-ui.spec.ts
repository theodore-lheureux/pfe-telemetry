import { once } from "node:events";
import { createServer } from "node:http";
import { m } from "@recount/i18n/messages";
import * as organizations from "../../src/organizations/organizations.server";
import * as projects from "../../src/organizations/projects.server";
import { test as base, data, expect } from "./fixtures";

interface Row {
	project: string;
	executionKey: string;
	name: string;
	workloadVersion: string | null;
	parameters: [string, string][];
	nodeCount: number;
	participantCount: number;
	firstSeenNs: string;
	lastSeenNs: string;
}
const test = base.extend<{ executionRows: Row[] }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture arguments.
	executionRows: async ({}, use) => {
		await use([]);
	},
	workspaceEnvironment: async ({ executionRows }, use) => {
		const server = createServer((request, response) => {
			let query = "";
			request.on("data", (chunk) => {
				query += chunk.toString();
			});
			request.on("end", () => {
				const params = new URL(request.url ?? "/", "http://fixture.invalid")
					.searchParams;
				const rows = executionRows.filter(
					(row) =>
						row.project === params.get("param_project") &&
						(!params.get("param_key") ||
							row.executionKey === params.get("param_key")) &&
						row.executionKey > (params.get("param_after") ?? ""),
				);
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					query.includes("execution_participants")
						? rows.map((row) => `${JSON.stringify(row)}\n`).join("")
						: "",
				);
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Expected fixture port");
		try {
			await use({
				RECOUNT_CLICKHOUSE_URL: `http://127.0.0.1:${address.port}`,
				RECOUNT_CLICKHOUSE_READER_PASSWORD: "fixture",
			});
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
});

for (const locale of ["en", "fr"] as const) {
	test(`execution keys and lifecycle metadata are read-only (${locale})`, async ({
		page,
		workspace,
		executionRows,
	}, testInfo) => {
		const owner = await workspace.signIn(
			page,
			`execution-${locale}@example.invalid`,
		);
		const organization = data(
			await workspace.operations(owner.headers, () =>
				organizations.createOrganization(workspace.auth, owner.headers, {
					name: "Executions",
					slug: `executions-${locale}`,
				}),
			),
		);
		const project = data(
			await workspace.operations(owner.headers, (actor) =>
				projects.createProject(workspace.database.db, actor, {
					requestId: crypto.randomUUID(),
					organizationId: organization.id,
					name: "Private",
				}),
			),
		);
		const url = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}/executions`;
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		await page.goto(url);
		await expect(
			page.getByText(m.execution_claims_hint({}, { locale })),
		).toBeVisible();
		executionRows.push({
			project: project.id,
			executionKey: "run:Node-A/one",
			name: "Distributed job",
			workloadVersion: "build-a",
			parameters: [["label", "<node>"]],
			nodeCount: 2,
			participantCount: 2,
			firstSeenNs: "1793700000000000000",
			lastSeenNs: "1793700001000000000",
		});
		await page.reload();
		await page
			.getByRole("link", { name: "Distributed job", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Distributed job", exact: true }),
		).toBeVisible();
		await expect(page.getByText("run:Node-A/one")).toBeVisible();
		await expect(page.getByText("<node>", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("button", {
				name: m.record_execution({}, { locale }),
				exact: true,
			}),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", {
				name: m.save_name({}, { locale }),
				exact: true,
			}),
		).toHaveCount(0);
		await page.screenshot({
			path: testInfo.outputPath(`execution-key-${locale}.png`),
			fullPage: true,
		});
		await workspace.signIn(
			page,
			`execution-outsider-${locale}@example.invalid`,
		);
		const response = await page.goto(
			`${url}/${encodeURIComponent("run:Node-A/one")}`,
		);
		expect(response?.status()).toBe(404);
		await expect(page.getByText("run:Node-A/one")).toHaveCount(0);
	});
}
