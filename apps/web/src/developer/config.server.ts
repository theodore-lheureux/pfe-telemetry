import { z } from "zod";

const configuration = z.object({
	baseUrl: z.string().url(),
	projectId: z.coerce.number().int().positive(),
	token: z.string().min(1),
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
		baseUrl: env.RECOUNT_SEMAPHORE_URL,
		projectId: env.RECOUNT_SEMAPHORE_PROJECT_ID,
		token: env.RECOUNT_SEMAPHORE_TOKEN,
		gpuEnabled: env.RECOUNT_SEMAPHORE_GPU_ENABLED === "true",
	});
	if (!result.success) return null;
	const url = new URL(result.data.baseUrl);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		return null;
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
