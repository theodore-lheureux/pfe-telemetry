import { InputError } from "../lib/input-error";
import type {
	ProjectCustomizationChange,
	ProjectCustomizationInput,
} from "./contracts";
import { parseProjectReference } from "./validation";

function invalid(): never {
	throw new InputError(
		"INVALID_PROJECT_SETTING",
		"Invalid project customization",
	);
}

export function parseProjectCustomization(
	value: unknown,
): ProjectCustomizationInput {
	const reference = parseProjectReference(value);
	const input = value as Record<string, unknown>;
	if (input.action === "add-tag" || input.action === "remove-tag") {
		if (typeof input.tag !== "string") return invalid();
		const tag = input.tag.trim().normalize("NFC");
		if (!tag || tag.length > 40 || /\p{Cc}/u.test(tag)) return invalid();
		return { ...reference, action: input.action, tag };
	}
	if (input.action === "group") {
		if (typeof input.projectGroup !== "string") return invalid();
		const projectGroup = input.projectGroup.trim().normalize("NFC");
		if (projectGroup.length > 80 || /\p{Cc}/u.test(projectGroup))
			return invalid();
		return { ...reference, action: "group", projectGroup };
	}
	if (input.action === "time-zone") {
		if (
			typeof input.timeZone !== "string" ||
			input.timeZone.length > 100 ||
			!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(input.timeZone)
		)
			return invalid();
		try {
			new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
		} catch {
			return invalid();
		}
		return { ...reference, action: "time-zone", timeZone: input.timeZone };
	}
	if (
		input.action === "week-start" &&
		typeof input.weekStartsOn === "number" &&
		Number.isInteger(input.weekStartsOn) &&
		// Calendars start on Sunday or Monday.
		(input.weekStartsOn === 0 || input.weekStartsOn === 1)
	)
		return {
			...reference,
			action: "week-start",
			weekStartsOn: input.weekStartsOn,
		};
	return invalid();
}

export function changedProjectTags(
	tags: string[],
	change: Extract<ProjectCustomizationChange, { tag: string }>,
) {
	const same = (tag: string) => tag.toLowerCase() === change.tag.toLowerCase();
	if (change.action === "remove-tag") return tags.filter((tag) => !same(tag));
	if (tags.some(same)) return tags;
	if (tags.length >= 20) return invalid();
	return [...tags, change.tag];
}
