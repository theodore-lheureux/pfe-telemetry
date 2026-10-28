import type { CompilerOptions } from "@inlang/paraglide-js";

export const compilerOptions = {
	strategy: ["cookie", "baseLocale"],
	cookieName: "pfe_locale",
	cookieMaxAge: 31_536_000,
	cookieSameSite: "lax",
	cookieSecure: "auto",
	emitTsDeclarations: true,
	outputStructure: "message-modules",
} satisfies Partial<CompilerOptions>;
