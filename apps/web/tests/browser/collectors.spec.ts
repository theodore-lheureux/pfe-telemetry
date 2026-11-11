import { generateKeyPairSync } from "node:crypto";
import * as organizations from "../../src/organizations/organizations.server";
import * as projects from "../../src/organizations/projects.server";
import { settingsPath } from "../settings-path";
import { data, expect, test } from "./fixtures";

function publicKey() {
	const { publicKey } = generateKeyPairSync("ed25519");
	return publicKey.export({ format: "jwk" }).x as string;
}

test("admins create enrollment keys and manage the nodes that enroll with them", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "fleet-owner@example.invalid");
	const organization = data(
		await workspace.operations(owner.headers, () =>
			organizations.createOrganization(workspace.auth, owner.headers, {
				name: "Fleet",
				slug: "fleet",
			}),
		),
	);
	const project = data(
		await workspace.operations(owner.headers, (actor) =>
			projects.createProject(workspace.database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: organization.id,
				name: "Fleet project",
			}),
		),
	);
	await page.goto(
		workspace.origin +
			settingsPath("collectors", {
				organizationId: organization.id,
				projectId: project.id,
			}),
	);
	await expect(
		page.getByRole("heading", { name: "No nodes yet", exact: true }),
	).toBeVisible();

	await page
		.getByRole("button", { name: "Create enrollment key", exact: true })
		.click();
	const create = page.getByRole("dialog", { name: "Create enrollment key" });
	await create.getByLabel("Name", { exact: true }).fill("prod-linux");
	await create.getByLabel("Labels", { exact: true }).fill("prod, linux");
	await create
		.getByRole("button", { name: "Create enrollment key", exact: true })
		.click();
	const reveal = page.getByRole("dialog", { name: "Save your enrollment key" });
	const key = (await reveal.locator("code").first().textContent()) ?? "";
	expect(key).toMatch(/^recount_enroll_/);
	await expect(reveal).toContainText(
		`RECOUNT_COLLECTOR_ENROLLMENT_URL=${workspace.origin}`,
	);
	expect(await reveal.locator("pre").allTextContents()).not.toContain(key);
	await reveal.getByRole("button", { name: "Done", exact: true }).click();
	await expect(page.getByText("prod-linux", { exact: true })).toBeVisible();

	const enroll = (body: Record<string, unknown>) =>
		page.request.post(`${workspace.origin}/api/collectors/enroll`, {
			data: body,
		});
	const rejected = await enroll({
		enrollmentKey: key.replace(/.$/, (last) => (last === "A" ? "B" : "A")),
		machineId: "machine-x",
		hostname: "x",
		publicKey: publicKey(),
	});
	expect(rejected.status()).toBe(403);
	expect(await rejected.json()).toEqual({ error: "FORBIDDEN" });
	for (const [machineId, hostname] of [
		["machine-web", "web-01"],
		["machine-db", "db-01"],
	]) {
		const response = await enroll({
			enrollmentKey: key,
			machineId,
			hostname,
			publicKey: publicKey(),
			collectorVersion: "1.0.0",
		});
		expect(response.status()).toBe(200);
		const body = await response.json();
		expect(body.token.split(".")).toHaveLength(3);
		expect(response.headers()["cache-control"]).toContain("no-store");
	}
	const keys = await page.request.get(
		`${workspace.origin}/.well-known/recount-collector-keys`,
	);
	expect((await keys.json()).keys[0]).toMatchObject({
		kty: "OKP",
		crv: "Ed25519",
		alg: "EdDSA",
	});

	await page.reload();
	const table = page.getByRole("table", { name: "Nodes", exact: true });
	await expect(table.getByText("web-01", { exact: true })).toBeVisible();
	await expect(table.getByText("db-01", { exact: true })).toBeVisible();
	await expect(table.getByText("prod", { exact: true }).first()).toBeVisible();
	await page
		.getByLabel("Search hosts, machine IDs or labels", { exact: true })
		.fill("web");
	await expect(table.getByText("db-01", { exact: true })).toHaveCount(0);
	await page
		.getByLabel("Search hosts, machine IDs or labels", { exact: true })
		.fill("");
	await expect(table.getByText("db-01", { exact: true })).toBeVisible();

	await page.getByLabel("Select db-01", { exact: true }).click();
	await page
		.getByRole("button", { name: "Revoke", exact: true })
		.first()
		.click();
	const confirm = page.getByRole("alertdialog");
	await expect(confirm).toContainText("Revoke 1 nodes?");
	await confirm.getByRole("button", { name: "Revoke", exact: true }).click();
	await expect(confirm).toHaveCount(0);
	await expect(table.getByText("db-01", { exact: true })).toHaveCount(0);
	await page.getByLabel("Status", { exact: true }).selectOption("revoked");
	await expect(table.getByText("db-01", { exact: true })).toBeVisible();

	await page.getByLabel("Status", { exact: true }).selectOption("all");
	await page.getByLabel("Select web-01", { exact: true }).click();
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await confirm.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(table.getByText("web-01", { exact: true })).toHaveCount(0);
	await expect(table.getByText("db-01", { exact: true })).toBeVisible();
});
