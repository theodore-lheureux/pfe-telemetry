// Tags label projects and saved insights. Comparison ignores case, so "Prod" and "prod"
// are one tag, and the first spelling is kept.

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

/** A tag trimmed and normalized, or null when it is empty, too long or has controls. */
export function normalizeTag(value: unknown) {
	if (typeof value !== "string") return null;
	const tag = value.trim().normalize("NFC");
	if (!tag || tag.length > MAX_TAG_LENGTH || /\p{Cc}/u.test(tag)) return null;
	return tag;
}

export function sameTag(left: string, right: string) {
	return left.toLowerCase() === right.toLowerCase();
}

export function hasTag(tags: string[], tag: string) {
	return tags.some((entry) => sameTag(entry, tag));
}

/** Tags with `added` appended unless already present; null when that exceeds the limit. */
export function withTags(tags: string[], added: string[]) {
	const next = [...tags];
	for (const tag of added) if (!hasTag(next, tag)) next.push(tag);
	return next.length > MAX_TAGS ? null : next;
}

export function withoutTags(tags: string[], removed: string[]) {
	return tags.filter((tag) => !hasTag(removed, tag));
}

/** Tags with a typed tag added, or null when it is invalid or exceeds the limit. */
export function addTag(tags: string[], input: string) {
	const tag = normalizeTag(input);
	return tag ? withTags(tags, [tag]) : null;
}
