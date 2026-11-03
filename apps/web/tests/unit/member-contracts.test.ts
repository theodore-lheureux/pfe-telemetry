import { expect, test } from "bun:test";
import {
	parseMemberReference,
	parseMemberRole,
} from "../../src/organizations/member-contracts";

test("member mutations require explicit tenant and member identifiers", () => {
	expect(
		parseMemberReference({
			organizationId: "org-a",
			memberId: "member-a",
			userId: "ignored",
		}),
	).toEqual({ organizationId: "org-a", memberId: "member-a" });
	for (const input of [
		null,
		{},
		{ memberId: "member-a" },
		{ organizationId: "org-a" },
		{ organizationId: "org-a", memberId: "" },
	]) {
		expect(() => parseMemberReference(input)).toThrow();
	}
});

test("member role inputs accept only a single canonical role", () => {
	const reference = { organizationId: "org-a", memberId: "member-a" };
	for (const role of ["owner", "admin", "member"] as const)
		expect(parseMemberRole({ ...reference, role })).toEqual({
			...reference,
			role,
		});
	for (const role of ["admin,owner", ["admin", "owner"], "operator", "", null])
		expect(() => parseMemberRole({ ...reference, role })).toThrow();
});
