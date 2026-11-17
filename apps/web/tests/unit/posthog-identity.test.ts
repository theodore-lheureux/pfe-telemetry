import { expect, mock, test } from "bun:test";
import { identifyPerson } from "../../src/lib/posthog-identity";

const user = {
	id: "stable-account-id",
	email: "not.a.name@example.invalid",
	name: "  Marie\t Claire \n de  la Cruz  ",
};

test("identify preserves canonical identity and normalizes only derived name properties", () => {
	const identify = mock();
	const unsetPersonProperties = mock();
	identifyPerson({ identify, unsetPersonProperties }, user);
	expect(identify.mock.calls).toEqual([
		[
			user.id,
			{
				email: user.email,
				name: user.name,
				first_name: "Marie",
				last_name: "Claire de la Cruz",
			},
		],
	]);
	expect(unsetPersonProperties).not.toHaveBeenCalled();
});

test("mononyms omit last_name without fabricating or parsing email", () => {
	const identify = mock();
	const unsetPersonProperties = mock();
	identifyPerson(
		{ identify, unsetPersonProperties },
		{ ...user, name: "  Madonna  " },
	);
	expect(identify.mock.calls).toEqual([
		[
			user.id,
			{
				email: user.email,
				name: "  Madonna  ",
				first_name: "Madonna",
			},
		],
	]);
	expect(unsetPersonProperties.mock.calls).toEqual([[["last_name"]]]);
});

test("blank names omit both derived properties instead of sending clearing values", () => {
	for (const name of ["", " \t\n ", "\u00a0"]) {
		const identify = mock();
		const unsetPersonProperties = mock();
		identifyPerson({ identify, unsetPersonProperties }, { ...user, name });
		expect(identify.mock.calls).toEqual([
			[user.id, { email: user.email, name }],
		]);
		expect(unsetPersonProperties.mock.calls).toEqual([
			[["first_name", "last_name"]],
		]);
	}
});

test("profile updates retain the ID and subsequent accounts inherit no derived names", () => {
	const identify = mock();
	const reset = mock();
	const posthog = { identify, reset, unsetPersonProperties: mock() };
	identifyPerson(posthog, user);
	identifyPerson(posthog, { ...user, name: "Changed Display Name" });
	identifyPerson(posthog, {
		id: "another-account",
		email: "other@example.invalid",
		name: "",
	});
	expect(identify.mock.calls[1]).toEqual([
		user.id,
		{
			email: user.email,
			name: "Changed Display Name",
			first_name: "Changed",
			last_name: "Display Name",
		},
	]);
	expect(identify.mock.calls[2]).toEqual([
		"another-account",
		{ email: "other@example.invalid", name: "" },
	]);
	expect(reset).not.toHaveBeenCalled();
});

test("missing derived names are removed only after identifying the current account", () => {
	const people = new Map<string, Record<string, string>>([
		["another-account", { first_name: "Old", last_name: "Other" }],
	]);
	let currentId = "previous-account";
	const events: unknown[] = [];
	const reset = mock();
	const posthog = {
		reset,
		identify: (id: string, properties: Record<string, string>) => {
			currentId = id;
			people.set(id, { ...people.get(id), ...properties });
			events.push(["identify", id]);
		},
		unsetPersonProperties: (propertyNames: string | string[]) => {
			const names = [propertyNames].flat();
			const person = people.get(currentId);
			if (!person) throw new Error("Identify must establish the person first");
			for (const name of names) delete person[name];
			events.push(["unset", currentId, names]);
		},
	};
	identifyPerson(posthog, { ...user, name: "Full Name" });
	expect(people.get(user.id)).toEqual({
		email: user.email,
		name: "Full Name",
		first_name: "Full",
		last_name: "Name",
	});
	identifyPerson(posthog, { ...user, name: "Mononym" });
	expect(people.get(user.id)).toEqual({
		email: user.email,
		name: "Mononym",
		first_name: "Mononym",
	});
	identifyPerson(posthog, { ...user, name: "" });
	expect(people.get(user.id)).toEqual({ email: user.email, name: "" });
	identifyPerson(posthog, { ...user, name: "Preserved Person" });
	identifyPerson(posthog, {
		id: "another-account",
		email: "other@example.invalid",
		name: "",
	});
	expect(people.get(user.id)).toEqual({
		email: user.email,
		name: "Preserved Person",
		first_name: "Preserved",
		last_name: "Person",
	});
	expect(people.get("another-account")).toEqual({
		email: "other@example.invalid",
		name: "",
	});
	expect(people.has("previous-account")).toBe(false);
	expect(events).toEqual([
		["identify", user.id],
		["identify", user.id],
		["unset", user.id, ["last_name"]],
		["identify", user.id],
		["unset", user.id, ["first_name", "last_name"]],
		["identify", user.id],
		["identify", "another-account"],
		["unset", "another-account", ["first_name", "last_name"]],
	]);
	expect(reset).not.toHaveBeenCalled();
});
