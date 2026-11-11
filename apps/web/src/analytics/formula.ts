// Formulas combine measures per bucket and group, such as `(1 - idle / total) * 100`.
// The grammar is arithmetic only: numbers, measure names, + - * /, unary minus and
// parentheses. Parsing never evaluates code, so a formula is safe to accept from clients.

export type FormulaNode =
	| { type: "number"; value: number }
	| { type: "measure"; name: string }
	| { type: "negate"; operand: FormulaNode }
	| {
			type: "binary";
			op: "+" | "-" | "*" | "/";
			left: FormulaNode;
			right: FormulaNode;
	  };

export class FormulaError extends Error {}

const MAX_LENGTH = 200;
const MAX_DEPTH = 32;
const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z][A-Za-z0-9_]*)|([-+*/()]))/y;

type Token =
	| { kind: "number"; value: number }
	| { kind: "name"; value: string }
	| { kind: "symbol"; value: string };

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	TOKEN.lastIndex = 0;
	while (TOKEN.lastIndex < text.length) {
		if (/^\s*$/.test(text.slice(TOKEN.lastIndex))) break;
		const start = TOKEN.lastIndex;
		const match = TOKEN.exec(text);
		if (!match || TOKEN.lastIndex === start)
			throw new FormulaError(`Unexpected character at ${start + 1}`);
		if (match[1] !== undefined)
			tokens.push({ kind: "number", value: Number(match[1]) });
		else if (match[2] !== undefined)
			tokens.push({ kind: "name", value: match[2] });
		else tokens.push({ kind: "symbol", value: match[3] ?? "" });
	}
	return tokens;
}

/** Parses a formula; every name must be one of `measures`. */
export function parseFormula(text: string, measures: string[]): FormulaNode {
	if (!text.trim() || text.length > MAX_LENGTH)
		throw new FormulaError("Formula is empty or too long");
	const tokens = tokenize(text);
	const known = new Set(measures);
	let position = 0;
	const peek = () => tokens[position];
	const symbol = (value: string) => {
		const token = peek();
		if (token?.kind === "symbol" && token.value === value) {
			position++;
			return true;
		}
		return false;
	};
	const expression = (depth: number): FormulaNode => {
		let node = term(depth);
		for (;;) {
			const op = peek();
			if (op?.kind !== "symbol" || (op.value !== "+" && op.value !== "-"))
				return node;
			position++;
			node = { type: "binary", op: op.value, left: node, right: term(depth) };
		}
	};
	const term = (depth: number): FormulaNode => {
		let node = unary(depth);
		for (;;) {
			const op = peek();
			if (op?.kind !== "symbol" || (op.value !== "*" && op.value !== "/"))
				return node;
			position++;
			node = { type: "binary", op: op.value, left: node, right: unary(depth) };
		}
	};
	const unary = (depth: number): FormulaNode => {
		if (depth > MAX_DEPTH)
			throw new FormulaError("Formula is too deeply nested");
		if (symbol("-")) return { type: "negate", operand: unary(depth + 1) };
		if (symbol("+")) return unary(depth + 1);
		const token = peek();
		if (!token) throw new FormulaError("Formula ends unexpectedly");
		if (symbol("(")) {
			const node = expression(depth + 1);
			if (!symbol(")")) throw new FormulaError("Missing closing parenthesis");
			return node;
		}
		position++;
		if (token.kind === "number") return { type: "number", value: token.value };
		if (token.kind === "name") {
			if (!known.has(token.value))
				throw new FormulaError(`Unknown series ${token.value}`);
			return { type: "measure", name: token.value };
		}
		throw new FormulaError(`Unexpected ${token.value}`);
	};
	const node = expression(0);
	if (position < tokens.length)
		throw new FormulaError(`Unexpected ${String(tokens[position]?.value)}`);
	return node;
}

/** The measures a formula reads. */
export function formulaMeasures(node: FormulaNode): Set<string> {
	switch (node.type) {
		case "number":
			return new Set();
		case "measure":
			return new Set([node.name]);
		case "negate":
			return formulaMeasures(node.operand);
		case "binary":
			return new Set([
				...formulaMeasures(node.left),
				...formulaMeasures(node.right),
			]);
	}
}

/**
 * Evaluates a formula for one bucket. A missing input or a division by zero yields null,
 * so gaps stay gaps instead of becoming zeros or infinities.
 */
export function evaluateFormula(
	node: FormulaNode,
	values: (name: string) => number | null,
): number | null {
	switch (node.type) {
		case "number":
			return node.value;
		case "measure":
			return values(node.name);
		case "negate": {
			const value = evaluateFormula(node.operand, values);
			return value === null ? null : -value;
		}
		case "binary": {
			const left = evaluateFormula(node.left, values);
			const right = evaluateFormula(node.right, values);
			if (left === null || right === null) return null;
			if (node.op === "/") return right === 0 ? null : left / right;
			const result =
				node.op === "+"
					? left + right
					: node.op === "-"
						? left - right
						: left * right;
			return Number.isFinite(result) ? result : null;
		}
	}
}
