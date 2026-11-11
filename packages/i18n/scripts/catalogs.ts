import { readFile } from "node:fs/promises";

export function validateCatalogPair(
	english: Record<string, string>,
	french: Record<string, string>,
) {
	const keys = Object.keys(english).sort();
	if (
		keys.length === 0 ||
		JSON.stringify(keys) !== JSON.stringify(Object.keys(french).sort())
	)
		throw new Error("EN/FR message catalogs must have matching, nonempty keys");

	const parameters = (value: string) =>
		[...value.matchAll(/\{(\w+)\}/g)]
			.map((match) => match[1])
			.sort()
			.join();
	for (const [key, message] of Object.entries(english)) {
		if (
			typeof message !== "string" ||
			!message ||
			typeof french[key] !== "string" ||
			!french[key] ||
			parameters(message) !== parameters(french[key])
		)
			throw new Error(`Missing or mismatched EN/FR message: ${key}`);
	}
}

export async function validateMessageCatalogs() {
	const catalog = async (locale: string) =>
		JSON.parse(
			await readFile(
				new URL(`../messages/${locale}.json`, import.meta.url),
				"utf8",
			),
		) as Record<string, string>;
	const [english, french] = await Promise.all([catalog("en"), catalog("fr")]);
	validateCatalogPair(english, french);
}
