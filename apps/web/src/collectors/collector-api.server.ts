import { getDatabase } from "../db/client.server";
import { InputError } from "../lib/input-error";
import { OperationError } from "../lib/operation-error";
import { enrollNode, issueNodeToken } from "./collectors.server";
import { publicKeySet } from "./tokens.server";

const STATUS = {
	FORBIDDEN: 403,
	CAPACITY: 409,
	INVALID_INPUT: 400,
	NOT_FOUND: 404,
} as const;

function json(body: unknown, status = 200) {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

// Collector-facing endpoints answer with JSON and stable error codes; details stay out of
// responses so rejected keys and nodes are indistinguishable.
async function handle(
	request: Request,
	action: (body: unknown) => Promise<unknown>,
) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: "INVALID_INPUT" }, 400);
	}
	try {
		return json(await action(body));
	} catch (error) {
		if (error instanceof OperationError)
			return json(
				{ error: error.code },
				STATUS[error.code as keyof typeof STATUS] ?? 400,
			);
		if (error instanceof InputError || error instanceof Error)
			return json({ error: "INVALID_INPUT" }, 400);
		throw error;
	}
}

export function handleEnroll(request: Request) {
	return handle(request, (body) => enrollNode(getDatabase(), body as never));
}

export function handleToken(request: Request) {
	return handle(request, (body) =>
		issueNodeToken(getDatabase(), body as never),
	);
}

export function handlePublicKeys() {
	return Response.json(publicKeySet(), {
		headers: { "Cache-Control": "public, max-age=300" },
	});
}
