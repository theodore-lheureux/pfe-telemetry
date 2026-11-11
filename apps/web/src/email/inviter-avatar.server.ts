import { gravatarUrl } from "../auth/avatar.server";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);
const MAX_BYTES = 64 * 1024;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface InlineAvatar {
	content: Buffer;
	contentType: string;
}

/**
 * Fetches a Gravatar photo to attach to an email, so recipients never contact Gravatar
 * themselves. Any failure, including no photo, falls back to the initial in the template.
 */
export async function fetchGravatar(
	email: string,
	fetcher: Fetcher = fetch,
): Promise<InlineAvatar | null> {
	try {
		const response = await fetcher(gravatarUrl(email), {
			signal: AbortSignal.timeout(3000),
			redirect: "error",
		});
		const contentType =
			response.headers.get("Content-Type")?.split(";")[0]?.trim() ?? "";
		if (!response.ok || !IMAGE_TYPES.has(contentType)) return null;
		if (Number(response.headers.get("Content-Length")) > MAX_BYTES) return null;
		const content = Buffer.from(await response.arrayBuffer());
		if (!content.length || content.length > MAX_BYTES) return null;
		return { content, contentType };
	} catch {
		return null;
	}
}
