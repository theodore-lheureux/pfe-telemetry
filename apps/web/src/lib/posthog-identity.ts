type PersonIdentity = { id: string; email: string; name: string };

type PersonProperties = {
	email: string;
	name: string;
	first_name?: string;
	last_name?: string;
};

export function identifyPerson(
	posthog: {
		identify: (id: string, properties: PersonProperties) => void;
		unsetPersonProperties: (propertyNames: string | string[]) => void;
	},
	user: PersonIdentity,
) {
	const parts = user.name.trim().split(/\s+/).filter(Boolean);
	const firstName = parts[0];
	const lastName = parts.slice(1).join(" ");

	// Derived names are best-effort, not verified given/family names.
	posthog.identify(user.id, {
		email: user.email,
		name: user.name,
		...(firstName && { first_name: firstName }),
		...(lastName && { last_name: lastName }),
	});
	// Identify first so cleanup targets this person, including after an account switch.
	const absentNames: string[] = [];
	if (!firstName) absentNames.push("first_name");
	if (!lastName) absentNames.push("last_name");
	if (absentNames.length) posthog.unsetPersonProperties(absentNames);
}
