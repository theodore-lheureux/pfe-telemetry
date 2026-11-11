import { readFileSync } from "node:fs";
import { parseAst } from "@tanstack/router-utils";

export function serverFunctionPaths(
	filename: URL,
): (operation: string) => string {
	const source = parseAst({
		code: readFileSync(filename, "utf8"),
		filename: filename.pathname,
	});
	const manifest = new Map<string, readonly string[]>();
	for (const statement of source.program.body) {
		if (statement.type !== "VariableDeclaration") continue;
		for (const declaration of statement.declarations) {
			if (declaration.init?.type !== "ObjectExpression") continue;
			for (const entry of declaration.init.properties) {
				if (
					entry.type !== "ObjectProperty" ||
					entry.key.type !== "StringLiteral" ||
					entry.value.type !== "ObjectExpression"
				)
					continue;
				const field = entry.value.properties.find(
					(field) =>
						field.type === "ObjectProperty" &&
						((field.key.type === "Identifier" &&
							field.key.name === "functionName") ||
							(field.key.type === "StringLiteral" &&
								field.key.value === "functionName")) &&
						field.value.type === "StringLiteral",
				);
				if (
					field?.type !== "ObjectProperty" ||
					field.value.type !== "StringLiteral"
				)
					continue;
				const name = field.value.value;
				manifest.set(
					name,
					Object.freeze([
						...(manifest.get(name) ?? []),
						`/_serverFn/${encodeURIComponent(entry.key.value)}`,
					]),
				);
			}
		}
	}
	// Only immutable build metadata escapes parsing; no AST, requests or session data.
	return (operation) => {
		const paths = manifest.get(`${operation}_createServerFn_handler`) ?? [];
		if (paths.length !== 1)
			throw new Error(
				`Expected one generated server-function manifest entry for ${operation}`,
			);
		return paths[0];
	};
}
