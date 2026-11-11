// Slugs stay unique storage keys but are no longer chosen or shown; people identify
// organizations and projects by name and ID. The request ID suffix keeps them unique.
export function generatedSlug(
	name: string,
	requestId: string,
	fallback: string,
) {
	const base =
		name
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 45)
			.replace(/-$/g, "") || fallback;
	return `${base}-${requestId.slice(0, 8)}`;
}
