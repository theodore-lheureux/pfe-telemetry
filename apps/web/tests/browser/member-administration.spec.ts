import { and, eq } from "drizzle-orm";
import { invitation, member } from "../../src/db/schema";
import * as memberDomain from "../../src/organizations/members.server";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";
import {
	data,
	editMemberRole,
	expect,
	openInvitationForm,
	openMemberActions,
	openProjectGrant,
	settingsUrl,
	test,
} from "./fixtures";

test("manages native memberships and restricts administrator owner controls", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Member lab",
				slug: "member-lab",
			}),
		),
	);
	const administrator = await workspace.signIn(page, "admin@example.invalid");
	await workspace.auth.api.addMember({
		body: {
			organizationId: org.id,
			userId: administrator.userId,
			role: "admin",
		},
	});
	const collaborator = await workspace.signIn(
		page,
		"collaborator@example.invalid",
	);
	const collaboratorMember = await workspace.auth.api.addMember({
		body: {
			organizationId: org.id,
			userId: collaborator.userId,
			role: "member",
		},
	});
	await workspace.signIn(page, "owner@example.invalid");
	const url = settingsUrl(
		`${workspace.origin}/organizations/${org.id}`,
		"organization-members",
	);
	await page.goto(url);
	await expect(
		page.getByLabel("Role for owner@example.invalid", { exact: true }),
	).toHaveCount(0);
	await editMemberRole(page, "collaborator@example.invalid");
	await page
		.getByLabel("Role for collaborator@example.invalid", { exact: true })
		.selectOption("admin");
	await page
		.getByRole("button", {
			name: "Save role for collaborator@example.invalid",
			exact: true,
		})
		.press("Enter");
	await expect(
		page.getByText("Member role updated.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Organization members", exact: true }),
	).toBeFocused();
	expect(
		data(
			await workspace.operations(collaborator.headers, (actor) =>
				organizationDomain.getOrganization(
					workspace.database.db,
					actor,
					org.id,
				),
			),
		).role,
	).toBe("admin");
	await workspace.signIn(page, "admin@example.invalid");
	await page.goto(url);
	await expect(
		page.getByLabel("Role for owner@example.invalid", { exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("option", { name: "Owner", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", {
			name: "Remove member: owner@example.invalid",
			exact: true,
		}),
	).toHaveCount(0);
	await openMemberActions(page, "collaborator@example.invalid");
	await page
		.getByRole("menuitem", {
			name: "Remove member: collaborator@example.invalid",
			exact: true,
		})
		.click();
	await expect(
		page.getByText(
			"This removes their organization membership and all explicit project grants.",
			{ exact: false },
		),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Confirm removal", exact: true })
		.click();
	await expect(
		page.getByText("collaborator@example.invalid", { exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Organization members", exact: true }),
	).toBeFocused();
	expect(
		await workspace.database.db
			.select()
			.from(member)
			.where(eq(member.id, collaboratorMember.id)),
	).toHaveLength(0);
});

test("effective project administrators grant access and can give up their own administration", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Grant lab",
				slug: "grant-lab",
			}),
		),
	);
	const project = data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.createProject(workspace.database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: org.id,
				name: "Private project",
				slug: "private",
			}),
		),
	);
	const manager = await workspace.signIn(page, "manager@example.invalid");
	const managerMember = await workspace.auth.api.addMember({
		body: { organizationId: org.id, userId: manager.userId, role: "member" },
	});
	const viewer = await workspace.signIn(page, "viewer@example.invalid");
	await workspace.auth.api.addMember({
		body: { organizationId: org.id, userId: viewer.userId, role: "member" },
	});
	const reference = { organizationId: org.id, projectId: project.id };
	data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.setProjectMember(workspace.database.db, actor, {
				...reference,
				memberId: managerMember.id,
				role: "admin",
			}),
		),
	);
	await workspace.signIn(page, "manager@example.invalid");
	await page.goto(
		settingsUrl(
			`${workspace.origin}/organizations/${org.id}/projects/${project.id}`,
			"project-members",
		),
	);
	await expect(
		page
			.getByRole("table", { name: "Roles", exact: true })
			.getByText("Owner", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByLabel("Project role for owner@example.invalid", { exact: true }),
	).toHaveCount(0);
	await openProjectGrant(page, "viewer@example.invalid");
	await expect(
		page.getByRole("button", {
			name: "Save project grant for viewer@example.invalid",
			exact: true,
		}),
	).toBeEnabled();
	await page
		.getByRole("button", {
			name: "Save project grant for viewer@example.invalid",
			exact: true,
		})
		.press("Enter");
	await expect(
		page.getByText("Project grant saved.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Access control", exact: true }),
	).toBeFocused();
	expect(
		data(
			await workspace.operations(viewer.headers, (actor) =>
				projectDomain.getProject(workspace.database.db, actor, reference),
			),
		).role,
	).toBe("viewer");
	await page
		.getByLabel("Project role for manager@example.invalid", { exact: true })
		.selectOption("viewer");
	await page
		.getByRole("button", {
			name: "Save project grant for manager@example.invalid",
			exact: true,
		})
		.click();
	await expect(
		page.getByText("This removes your project administrator access.", {
			exact: false,
		}),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Confirm access change", exact: true })
		.click();
	await expect(page).toHaveURL(`${workspace.origin}/organizations/${org.id}`);
	expect(
		(
			await workspace.operations(manager.headers, (actor) =>
				memberDomain.listProjectGrantCandidates(
					workspace.database.db,
					workspace.auth,
					manager.headers,
					actor,
					reference,
				),
			)
		).error?.code,
	).toBe("FORBIDDEN");
});

test("invitation login preserves return path and joining requires an explicit POST", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Invitation lab",
				slug: "invitation-lab",
			}),
		),
	);
	const invited = await workspace.auth.api.createInvitation({
		headers: owner.headers,
		body: {
			organizationId: org.id,
			email: "invited@example.invalid",
			role: "member",
		},
	});
	const landing = `/invitations/${invited.id}`;
	await page.context().clearCookies();
	await page.goto(`${workspace.origin}${landing}`);
	await expect(page).toHaveURL(/\/login\?redirect=/);
	expect(new URL(page.url()).searchParams.get("redirect")).toBe(landing);
	await workspace.enableCodeDelivery(page);
	await page
		.getByLabel("Email address", { exact: true })
		.fill("invited@example.invalid");
	await page
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	await workspace.submitReceivedCode(page, "invited@example.invalid");
	await expect(page).toHaveURL(`${workspace.origin}${landing}`);
	await expect(
		page.getByRole("button", { name: "Accept invitation", exact: true }),
	).toBeVisible();
	expect(
		await workspace.database.db
			.select()
			.from(member)
			.where(eq(member.organizationId, org.id)),
	).toHaveLength(1);
	expect(
		(
			await workspace.database.db
				.select()
				.from(invitation)
				.where(eq(invitation.id, invited.id))
		)[0].status,
	).toBe("pending");
	const mutation = page.waitForRequest(
		(request) => request.method() === "POST",
	);
	await page
		.getByRole("button", { name: "Accept invitation", exact: true })
		.click();
	await mutation;
	await expect(page).toHaveURL(`${workspace.origin}/organizations/${org.id}`);
	expect(
		await workspace.database.db
			.select()
			.from(member)
			.where(eq(member.organizationId, org.id)),
	).toHaveLength(2);
	await page.goto(`${workspace.origin}${landing}`);
	await expect(
		page.getByText(
			"This invitation is invalid, expired, canceled, or has already been used.",
			{ exact: false },
		),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Accept invitation", exact: true }),
	).toHaveCount(0);
});

test("invitation details stay private; expiry, rejection and cancellation are terminal", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Confidential invitation lab",
				slug: "confidential-lab",
			}),
		),
	);
	const invited = await workspace.auth.api.createInvitation({
		headers: owner.headers,
		body: {
			organizationId: org.id,
			email: "recipient@example.invalid",
			role: "member",
		},
	});
	await workspace.signIn(page, "wrong@example.invalid");
	await page.goto(`${workspace.origin}/invitations/${invited.id}`);
	await expect(
		page.getByText(
			"Sign in with the invited email address and verify it before opening this link.",
		),
	).toBeVisible();
	await expect(
		page.getByText("Confidential invitation lab", { exact: true }),
	).toHaveCount(0);
	await workspace.signIn(page, "recipient@example.invalid");
	await page.goto(`${workspace.origin}/invitations/${invited.id}`);
	await page
		.getByRole("button", { name: "Reject invitation", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Confirm rejection", exact: true })
		.click();
	await expect(
		page.getByText(
			"Invitation rejected. Rejecting an invitation does not remove an existing membership.",
		),
	).toBeVisible();
	expect(
		await workspace.database.db
			.select()
			.from(member)
			.where(
				and(eq(member.organizationId, org.id), eq(member.userId, owner.userId)),
			),
	).toHaveLength(1);
	expect(
		(
			await workspace.database.db
				.select()
				.from(invitation)
				.where(eq(invitation.id, invited.id))
		)[0].status,
	).toBe("rejected");
	const expired = await workspace.auth.api.createInvitation({
		headers: owner.headers,
		body: {
			organizationId: org.id,
			email: "recipient@example.invalid",
			role: "member",
		},
	});
	await workspace.database.db
		.update(invitation)
		.set({ expiresAt: new Date(Date.now() - 60_000) })
		.where(eq(invitation.id, expired.id));
	await page.goto(`${workspace.origin}/invitations/${expired.id}`);
	await expect(
		page.getByRole("button", { name: "Accept invitation", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByText(
			"This invitation is invalid, expired, canceled, or has already been used.",
			{ exact: false },
		),
	).toBeVisible();
	const cancelable = await workspace.auth.api.createInvitation({
		headers: owner.headers,
		body: {
			organizationId: org.id,
			email: "recipient@example.invalid",
			role: "member",
			resend: true,
		},
	});
	await workspace.signIn(page, "owner@example.invalid");
	await page.goto(
		settingsUrl(
			`${workspace.origin}/organizations/${org.id}`,
			"organization-members",
		),
	);
	await page
		.getByRole("button", {
			name: "Cancel invitation to recipient@example.invalid",
			exact: true,
		})
		.click();
	await page
		.getByRole("button", { name: "Confirm cancellation", exact: true })
		.click();
	await expect(
		page.getByText("Invitation canceled.", { exact: true }),
	).toBeVisible();
	expect(
		(
			await workspace.database.db
				.select()
				.from(invitation)
				.where(eq(invitation.id, cancelable.id))
		)[0].status,
	).toBe("canceled");
});

test("stale organization administration is rejected and the controls are refreshed", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Revocation lab",
				slug: "revocation-lab",
			}),
		),
	);
	const administrator = await workspace.signIn(page, "admin@example.invalid");
	const adminMember = await workspace.auth.api.addMember({
		body: {
			organizationId: org.id,
			userId: administrator.userId,
			role: "admin",
		},
	});
	const target = await workspace.signIn(page, "target@example.invalid");
	await workspace.auth.api.addMember({
		body: { organizationId: org.id, userId: target.userId, role: "member" },
	});
	await workspace.signIn(page, "admin@example.invalid");
	await page.goto(
		settingsUrl(
			`${workspace.origin}/organizations/${org.id}`,
			"organization-members",
		),
	);
	await openMemberActions(page, "target@example.invalid");
	await page
		.getByRole("menuitem", {
			name: "Remove member: target@example.invalid",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("button", { name: "Confirm removal", exact: true }),
	).toBeVisible();
	data(
		await workspace.operations(owner.headers, (actor) =>
			memberDomain.updateRole(
				workspace.database.db,
				workspace.auth,
				owner.headers,
				actor,
				{
					organizationId: org.id,
					memberId: adminMember.id,
					role: "member",
				},
			),
		),
	);
	await page
		.getByRole("button", { name: "Confirm removal", exact: true })
		.click();
	await expect(
		page.getByLabel("Role for target@example.invalid", { exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Pending invites", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Confirm removal", exact: true }),
	).toHaveCount(0);
	expect(
		data(
			await workspace.operations(target.headers, (actor) =>
				organizationDomain.getOrganization(
					workspace.database.db,
					actor,
					org.id,
				),
			),
		).role,
	).toBe("member");
});

test("a successful membership write survives a failed loader refresh", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Refresh lab",
				slug: "refresh-lab",
			}),
		),
	);
	const target = await workspace.signIn(page, "target@example.invalid");
	await workspace.auth.api.addMember({
		body: { organizationId: org.id, userId: target.userId, role: "member" },
	});
	await workspace.signIn(page, "owner@example.invalid");
	await page.goto(
		settingsUrl(
			`${workspace.origin}/organizations/${org.id}`,
			"organization-members",
		),
	);
	let writes = 0;
	page.on("request", (request) => {
		if (request.method() === "POST" && request.url().includes("/_serverFn/"))
			writes++;
	});
	await page.route("**/_serverFn/**", (route) =>
		route.request().method() === "GET" ? route.abort() : route.continue(),
	);
	await editMemberRole(page, "target@example.invalid");
	await page
		.getByLabel("Role for target@example.invalid", { exact: true })
		.selectOption("admin");
	await page
		.getByRole("button", {
			name: "Save role for target@example.invalid",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("heading", { name: "Something went wrong", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("status")).toContainText(
		"Your membership change was saved, but the page could not refresh.",
	);
	expect(writes).toBe(1);
	expect(
		data(
			await workspace.operations(target.headers, (actor) =>
				organizationDomain.getOrganization(
					workspace.database.db,
					actor,
					org.id,
				),
			),
		).role,
	).toBe("admin");
	await page.unroute("**/_serverFn/**");
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await editMemberRole(page, "target@example.invalid");
	await expect(
		page.getByLabel("Role for target@example.invalid", { exact: true }),
	).toHaveValue("admin");
	await expect(
		page.getByRole("button", { name: "Dismiss notice", exact: true }),
	).toHaveCount(0);
	expect(writes).toBe(1);
});

test("recovers pending invitation delivery with native resend and renews expired links", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Delivery lab",
				slug: "delivery-lab",
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
	await page
		.getByLabel("Email address", { exact: true })
		.fill("delivery@example.invalid");
	await page
		.getByRole("button", { name: "Send invitation", exact: true })
		.click();
	await expect(
		page.getByText("Invitation created.", { exact: false }),
	).toBeVisible();
	const [pending] = await workspace.database.db
		.select()
		.from(invitation)
		.where(eq(invitation.organizationId, org.id));
	expect(pending.status).toBe("pending");
	await page
		.getByRole("button", {
			name: "Resend invitation to delivery@example.invalid",
			exact: true,
		})
		.click();
	await expect(
		page.getByText("Invitation delivery requested again.", { exact: false }),
	).toBeVisible();
	expect(
		(
			await workspace.database.db
				.select()
				.from(invitation)
				.where(eq(invitation.id, pending.id))
		)[0].role,
	).toBe("member");
	await workspace.database.db
		.update(invitation)
		.set({ expiresAt: new Date(Date.now() - 60_000) })
		.where(eq(invitation.id, pending.id));
	await page.reload();
	await page
		.getByRole("button", {
			name: "Resend invitation to delivery@example.invalid",
			exact: true,
		})
		.click();
	await expect(
		page.getByText("Invitation delivery requested again.", { exact: false }),
	).toBeVisible();
	const invitations = await workspace.database.db
		.select()
		.from(invitation)
		.where(eq(invitation.organizationId, org.id));
	const renewed = invitations.find(
		(entry) =>
			entry.status === "pending" && entry.expiresAt.getTime() > Date.now(),
	);
	expect(renewed?.id).not.toBe(pending.id);
	expect(renewed?.expiresAt.getTime()).toBeGreaterThan(Date.now());
	expect(
		invitations.find((entry) => entry.id === pending.id)?.expiresAt.getTime(),
	).toBeLessThan(Date.now());
});
