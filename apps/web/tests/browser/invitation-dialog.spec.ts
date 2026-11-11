import { m } from "@recount/i18n/messages";
import { eq } from "drizzle-orm";
import { invitation } from "../../src/db/schema";
import * as organizationDomain from "../../src/organizations/organizations.server";
import { gate } from "../gate";
import {
	data,
	expect,
	openInvitationForm,
	settingsUrl,
	test,
} from "./fixtures";

for (const locale of ["en", "fr"] as const) {
	test(`organization invitation modal supports multiple recipients and personalization in ${locale}`, async ({
		page,
		workspace,
	}) => {
		const options = { locale };
		const owner = await workspace.signIn(page, "owner@example.invalid");
		const org = data(
			await workspace.operations(owner.headers, () =>
				organizationDomain.createOrganization(workspace.auth, owner.headers, {
					name: "Invite lab",
					slug: "invite-dialog",
				}),
			),
		);
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		await page.goto(
			settingsUrl(
				`${workspace.origin}/organizations/${org.id}`,
				"organization-members",
			),
		);
		await openInvitationForm(page, locale);
		const dialog = page.getByRole("dialog", {
			name: m.invite_others_to({ organization: org.name }, options),
		});
		await expect(dialog).toBeVisible();
		await expect(dialog).toHaveCSS("top", "32px");
		await expect(dialog).toHaveCSS("max-width", "768px");
		const submit = dialog.getByRole("button", {
			name: m.invite_team_members({}, options),
			exact: true,
		});
		await expect(submit).toBeDisabled();
		await expect(
			dialog.getByLabel(m.email_address({}, options), { exact: true }),
		).toBeFocused();
		await dialog
			.getByLabel(m.email_address({}, options), { exact: true })
			.fill("two..dots@example.invalid");
		await expect(submit).toBeDisabled();
		await dialog
			.getByLabel(m.email_address({}, options), { exact: true })
			.fill("jane@example.invalid");
		await dialog
			.getByLabel(m.invite_name_optional({}, options), { exact: true })
			.fill("Jane");
		await dialog
			.getByLabel(m.organization_role({}, options), { exact: true })
			.selectOption("admin");
		await dialog
			.getByRole("button", { name: m.add({}, options), exact: true })
			.click();
		await expect(submit).toBeDisabled();
		const second = dialog.getByRole("group", {
			name: m.invite_recipient({ number: 2 }, options),
		});
		await second
			.getByLabel(m.email_address({}, options), { exact: true })
			.fill("sam@example.invalid");
		await dialog
			.getByLabel(m.invite_message_optional({}, options), { exact: true })
			.fill("Welcome aboard!\nLet’s collaborate.");
		await expect(submit).toBeEnabled();
		await page.screenshot({
			path: test.info().outputPath(`invitation-dialog-${locale}.png`),
		});
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(dialog).toBeInViewport();
		await expect(dialog).toHaveCSS("top", "16px");
		expect(
			await dialog.evaluate(
				(element) => element.scrollWidth <= element.clientWidth,
			),
		).toBe(true);
		await submit.click();
		await expect(dialog).toHaveCount(0);
		await expect(
			page.getByRole("button", {
				name: m.settings_invite_member({}, options),
				exact: true,
			}),
		).toBeFocused();
		const entries = await workspace.database.db
			.select()
			.from(invitation)
			.where(eq(invitation.organizationId, org.id));
		expect(entries).toHaveLength(2);
		expect(
			entries.find((entry) => entry.email === "jane@example.invalid"),
		).toMatchObject({
			recipientName: "Jane",
			message: "Welcome aboard!\nLet’s collaborate.",
			role: "admin",
		});
		expect(
			entries.find((entry) => entry.email === "sam@example.invalid")?.role,
		).toBe("member");
		for (const entry of entries)
			expect(
				entry.expiresAt.getTime() - entry.createdAt.getTime(),
			).toBeGreaterThan(3 * 24 * 60 * 60 * 1000 - 5000);
		await openInvitationForm(page, locale);
		await expect(
			dialog.getByLabel(m.email_address({}, options), { exact: true }),
		).toHaveValue("");
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
	});
}

test("a partially successful invitation batch retains stable rows and retries only failed recipients", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Partial invites",
				slug: "partial-invites",
			}),
		),
	);
	await workspace.auth.api.createInvitation({
		headers: owner.headers,
		body: {
			organizationId: org.id,
			email: "existing@example.invalid",
			role: "member",
		},
	});
	await page.goto(
		settingsUrl(
			`${workspace.origin}/organizations/${org.id}`,
			"organization-members",
		),
	);
	await openInvitationForm(page);
	const dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("Email address", { exact: true })
		.fill("new@example.invalid");
	await dialog.getByRole("button", { name: "Add", exact: true }).click();
	await dialog
		.getByLabel("Email address", { exact: true })
		.nth(1)
		.fill("existing@example.invalid");
	const waiting = gate();
	const ready = gate();
	const bodies: string[] = [];
	await page.route("**/_serverFn/**", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		bodies.push(route.request().postData() ?? "");
		const response = await route.fetch();
		ready.release();
		await waiting.promise;
		await route.fulfill({ response }).catch(() => {});
	});
	try {
		await dialog
			.getByRole("button", { name: "Invite team members", exact: true })
			.click();
		await ready.promise;
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: "Cancel", exact: true }),
		).toBeDisabled();
		waiting.release();
		await expect(dialog.getByRole("alert")).toBeVisible();
		await expect(
			dialog.getByLabel("Email address", { exact: true }),
		).toHaveCount(2);
		await expect(
			dialog.getByLabel("Email address", { exact: true }).first(),
		).toBeDisabled();
		await expect(
			dialog.getByLabel("Email address", { exact: true }).nth(1),
		).toHaveValue("existing@example.invalid");
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toContain("new@example.invalid");
		expect(bodies[0]).toContain("existing@example.invalid");
		expect(
			await workspace.database.db
				.select()
				.from(invitation)
				.where(eq(invitation.organizationId, org.id)),
		).toHaveLength(2);
		await dialog
			.getByLabel("Email address", { exact: true })
			.nth(1)
			.fill("corrected@example.invalid");
		await dialog
			.getByRole("button", { name: "Invite team members", exact: true })
			.click();
		await expect(dialog).toHaveCount(0);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).not.toContain("new@example.invalid");
		expect(bodies[1]).toContain("corrected@example.invalid");
	} finally {
		waiting.release();
	}
});

test("a batch uses one write and keeps its geometry and values through saving, refresh and closing", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Stable batch",
				slug: "stable-batch",
			}),
		),
	);
	await page.goto(
		settingsUrl(
			`${workspace.origin}/organizations/${org.id}`,
			"organization-members",
		),
	);
	await openInvitationForm(page);
	const dialog = page.getByRole("dialog");
	const emails = [
		"one@example.invalid",
		"two@example.invalid",
		"three@example.invalid",
	];
	for (const [index, email] of emails.entries()) {
		if (index)
			await dialog.getByRole("button", { name: "Add", exact: true }).click();
		await dialog
			.getByLabel("Email address", { exact: true })
			.nth(index)
			.fill(email);
	}
	const before = await dialog.boundingBox();
	if (!before) throw new Error("Expected an invitation popup");
	const written = gate();
	const writeReleased = gate();
	const reading = gate();
	const readsReleased = gate();
	let writes = 0;
	await page.route("**/_serverFn/**", async (route) => {
		if (route.request().method() === "POST") {
			writes++;
			const response = await route.fetch();
			written.release();
			await writeReleased.promise;
			await route.fulfill({ response }).catch(() => {});
		} else {
			reading.release();
			await readsReleased.promise;
			await route.continue().catch(() => {});
		}
	});
	try {
		await dialog
			.getByRole("button", { name: "Invite team members", exact: true })
			.click();
		await written.promise;
		expect(writes).toBe(1);
		await expect(
			dialog.getByLabel("Email address", { exact: true }),
		).toHaveCount(3);
		for (const [index, email] of emails.entries()) {
			await expect(
				dialog.getByLabel("Email address", { exact: true }).nth(index),
			).toHaveValue(email);
			await expect(
				dialog.getByLabel("Email address", { exact: true }).nth(index),
			).toBeDisabled();
		}
		expect((await dialog.boundingBox())?.height).toBeCloseTo(before.height, 0);
		writeReleased.release();
		await reading.promise;
		await expect(
			dialog.getByRole("button", {
				name: "Updating invitation list…",
				exact: true,
			}),
		).toBeDisabled();
		await expect(
			dialog.getByLabel("Email address", { exact: true }),
		).toHaveCount(3);
		expect((await dialog.boundingBox())?.height).toBeCloseTo(before.height, 0);
		readsReleased.release();
		await expect(dialog).toHaveCount(0);
		expect(writes).toBe(1);
		expect(
			await workspace.database.db
				.select()
				.from(invitation)
				.where(eq(invitation.organizationId, org.id)),
		).toHaveLength(3);
	} finally {
		writeReleased.release();
		readsReleased.release();
	}
});

test("a lost batch response preserves entered rows and cannot blindly submit them again", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Unknown batch",
				slug: "unknown-batch",
			}),
		),
	);
	await page.goto(
		settingsUrl(
			`${workspace.origin}/organizations/${org.id}`,
			"organization-members",
		),
	);
	await openInvitationForm(page);
	const dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("Email address", { exact: true })
		.fill("lost-one@example.invalid");
	await dialog.getByRole("button", { name: "Add", exact: true }).click();
	await dialog
		.getByLabel("Email address", { exact: true })
		.nth(1)
		.fill("lost-two@example.invalid");
	let writes = 0;
	await page.route("**/_serverFn/**", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		writes++;
		await route.fetch();
		await route.abort();
	});
	await dialog
		.getByRole("button", { name: "Invite team members", exact: true })
		.click();
	await expect(dialog.getByRole("status")).toContainText(
		"Some invitations may have been created",
	);
	await expect(dialog.getByLabel("Email address", { exact: true })).toHaveCount(
		2,
	);
	await expect(
		dialog.getByRole("button", { name: "Invite team members", exact: true }),
	).toBeDisabled();
	await expect(
		dialog.getByRole("button", { name: "Cancel", exact: true }),
	).toBeEnabled();
	expect(writes).toBe(1);
	expect(
		await workspace.database.db
			.select()
			.from(invitation)
			.where(eq(invitation.organizationId, org.id)),
	).toHaveLength(2);
});
