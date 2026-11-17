import { posix } from "node:path";
import { z } from "zod";

const headerValue = z
	.string()
	.min(1)
	.max(4096)
	.regex(/^[\x21-\x7e]+$/);
const trustedUrl = z
	.string()
	.url()
	.refine((value) => {
		const url = new URL(value);
		return (
			value === value.trim() &&
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	});
export const semaphoreSocketAuthority = "http://localhost";
const socketPath = z
	.string()
	.refine(
		(value) =>
			value.length > 1 &&
			Buffer.byteLength(value) <= 107 &&
			posix.isAbsolute(value) &&
			posix.normalize(value) === value &&
			!value.endsWith("/") &&
			/^[\x21-\x7e]+$/.test(value),
	);
const configuration = z.object({
	baseUrl: z.string(),
	uiUrl: trustedUrl,
	projectId: z.coerce.number().int().positive(),
	token: headerValue,
	unixSocket: socketPath.optional(),
	gpuEnabled: z.boolean(),
});

export function isDeveloper(userId: string, env = process.env) {
	return (env.RECOUNT_DEVELOPER_USER_IDS ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean)
		.includes(userId);
}

export function semaphoreConfiguration(env = process.env) {
	const result = configuration.safeParse({
		baseUrl:
			env.RECOUNT_SEMAPHORE_UNIX_SOCKET === undefined
				? env.RECOUNT_SEMAPHORE_URL
				: semaphoreSocketAuthority,
		uiUrl: env.RECOUNT_SEMAPHORE_UI_URL,
		unixSocket: env.RECOUNT_SEMAPHORE_UNIX_SOCKET,
		projectId: env.RECOUNT_SEMAPHORE_PROJECT_ID,
		token: env.RECOUNT_SEMAPHORE_TOKEN,
		gpuEnabled: env.RECOUNT_SEMAPHORE_GPU_ENABLED === "true",
	});
	if (!result.success) return null;
	if (result.data.unixSocket) {
		if (env.RECOUNT_SEMAPHORE_URL !== undefined) return null;
	} else if (!trustedUrl.safeParse(result.data.baseUrl).success) return null;
	return result.data;
}
export type SemaphoreConfiguration = NonNullable<
	ReturnType<typeof semaphoreConfiguration>
>;

const labGrants = z.record(
	z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
	z
		.object({
			organizationId: z.string().min(1),
			projectId: z.string().uuid(),
			fleet: z.enum(["aws-cpu", "gcp-gpu"]),
		})
		.strict(),
);

export function configuredLabGrant(lab: string, env = process.env) {
	try {
		return (
			labGrants.parse(JSON.parse(env.RECOUNT_DEVELOPER_LAB_GRANTS ?? "{}"))[
				lab
			] ?? null
		);
	} catch {
		return null;
	}
}
