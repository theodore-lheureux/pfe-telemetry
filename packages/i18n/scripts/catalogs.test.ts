import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCatalogPair } from "./catalogs";

test("catalogs allow translated ordering of keys and placeholders", () => {
	assert.doesNotThrow(() =>
		validateCatalogPair(
			{ greeting: "Hello {name}, welcome to {organization}", action: "Open" },
			{
				action: "Ouvrir",
				greeting: "Bienvenue chez {organization}, {name}",
			},
		),
	);
});

const invalidCatalogs: [Record<string, string>, Record<string, string>][] = [
	[{}, {}],
	[{ action: "Open" }, { other: "Ouvrir" }],
	[
		{ "a,b": "Open", c: "Close" },
		{ a: "Ouvrir", "b,c": "Fermer" },
	],
	[{ action: "Hello {name}" }, { action: "Bonjour {person}" }],
	[{ action: "Hello {name}" }, { action: "Bonjour" }],
	[{ action: "Open" }, { action: "" }],
	[{ action: "" }, { action: "Ouvrir" }],
];

test("catalog validation rejects missing keys, empty messages and mismatched placeholders", () => {
	for (const [english, french] of invalidCatalogs) {
		assert.throws(() => validateCatalogPair(english, french));
	}
});
