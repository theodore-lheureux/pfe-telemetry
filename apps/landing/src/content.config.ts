import { defineCollection } from "astro:content";
import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
	changelog: defineCollection({
		loader: glob({ pattern: "**/*.md", base: "./src/content/changelog" }),
		schema: z.object({ title: z.string(), date: z.coerce.date() }),
	}),
	legal: defineCollection({
		loader: glob({ pattern: "**/*.md", base: "./src/content/legal" }),
		schema: z.object({
			title: z.string(),
			description: z.string(),
			updated: z.coerce.date(),
		}),
	}),
	i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
