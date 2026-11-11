import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
	LOCALE_KEY,
	langFromPath,
	localePath,
	switchPath,
} from "../src/i18n/locale.mjs";
import { localeInitializationScript } from "../src/i18n/preference-script.mjs";

test("locale paths distinguish French prefixes from other route names", () => {
	assert.equal(langFromPath("/fr"), "fr");
	assert.equal(langFromPath("/fr/docs/"), "fr");
	assert.equal(langFromPath("/french/"), "en");
	assert.equal(switchPath("/fr", "en"), "/");
	assert.equal(switchPath("/fr/docs/", "fr"), "/fr/docs/");
	assert.equal(localePath("fr", "/"), "/fr/");
});

for (const scenario of [
	{
		name: "French system",
		path: "/pricing/",
		system: "fr-CA",
		to: "/fr/pricing/",
	},
	{ name: "English system", path: "/docs/", system: "en-CA" },
	{ name: "explicit French URL", path: "/fr/docs/", system: "en" },
	{ name: "bare French root", path: "/fr", system: "en" },
	{
		name: "saved English",
		path: "/fr/docs/",
		system: "fr",
		saved: "en",
		to: "/docs/",
	},
	{
		name: "saved French",
		path: "/docs/",
		system: "en",
		saved: "fr",
		to: "/fr/docs/",
	},
	{
		name: "invalid saved locale",
		path: "/docs/",
		system: "fr",
		saved: "es",
		to: "/fr/docs/",
	},
	{
		name: "unavailable storage",
		path: "/docs/",
		system: "fr",
		unavailable: true,
		to: "/fr/docs/",
	},
	{
		name: "unavailable storage on French URL",
		path: "/fr/docs/",
		system: "en",
		unavailable: true,
	},
	{
		name: "navigator.language fallback",
		path: "/",
		system: "FR-fr",
		languages: [],
		to: "/fr/",
	},
]) {
	test(`pre-paint preference: ${scenario.name}`, () => {
		const redirects = [];
		const storageKeys = [];
		runInNewContext(localeInitializationScript, {
			localStorage: {
				getItem(key) {
					storageKeys.push(key);
					if (scenario.unavailable) throw new Error("Storage unavailable");
					return scenario.saved ?? null;
				},
			},
			navigator: {
				languages: scenario.languages ?? [scenario.system],
				language: scenario.system,
			},
			location: {
				pathname: scenario.path,
				search: "?source=docs",
				hash: "#install",
				replace: (url) => redirects.push(url),
			},
		});
		assert.deepEqual(storageKeys, [LOCALE_KEY]);
		assert.deepEqual(
			redirects,
			scenario.to ? [`${scenario.to}?source=docs#install`] : [],
		);
	});
}
