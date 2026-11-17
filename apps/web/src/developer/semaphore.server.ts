import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { OperationError } from "../lib/operation-error";
import type { SemaphoreConfiguration } from "./config.server";
import {
	isLoadAction,
	labSchema,
	playbooks,
	survey,
	type TaskSummary,
	taskStatuses,
	type WorkflowAction,
	type WorkflowInput,
	workflowFleet,
} from "./contracts";
import { redactNativeLog } from "./native-log.server";
import { publicTaskOutput } from "./public-results.server";
import { surveyNames, validActionMetadata } from "./template-metadata.server";

type TaskLabGuard = (
	lab: string,
	fleet: "aws-cpu" | "gcp-gpu",
) => Promise<void>;

const templateSchema = z.object({
	id: z.number().int().positive(),
	project_id: z.number(),
	app: z.literal("ansible"),
	playbook: z.string(),
	environment_ids: z.array(z.number().int().positive()).min(1),
	arguments: z.string().nullable().optional(),
	working_directory: z.string().nullable().optional(),
	survey_vars: z.unknown().optional(),
});
type Template = z.infer<typeof templateSchema>;
const taskSchema = z.object({
	id: z.number().int().positive(),
	template_id: z.number(),
	project_id: z.number(),
	status: z.enum(taskStatuses),
	created: z.iso.datetime({ offset: true }).nullable().optional(),
	environment: z.string().nullable().optional(),
	message: z.string().optional(),
});
const groupSchema = z.object({
	id: z.number(),
	project_id: z.number(),
	json: z.string(),
	env: z.string().nullable(),
	secrets: z
		.array(z.object({ name: z.string(), type: z.string() }))
		.default([]),
});

function unavailable(): never {
	throw new OperationError(
		"UNAVAILABLE",
		"Semaphore is unavailable or its project binding could not be verified",
	);
}

export function taskScopeMessage(
	token: string,
	projectId: string,
	templateId: number,
	environment: string,
	action: WorkflowAction,
) {
	const values = JSON.parse(environment);
	const sorted = Object.keys(values)
		.sort()
		.map((key) => [key, values[key]]);
	const digest = createHmac("sha256", token)
		.update(
			JSON.stringify([
				"recount-developer-task",
				projectId,
				templateId,
				action,
				sorted,
			]),
		)
		.digest("hex");
	return `recount:${digest}`;
}

async function boundedJson(response: Response) {
	const reader = response.body?.getReader();
	if (!reader) return unavailable();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 2_000_000) return unavailable();
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export class Semaphore {
	constructor(
		private config: SemaphoreConfiguration,
		private transport: typeof fetch = fetch,
	) {}

	private async request(path: string, body?: unknown): Promise<unknown> {
		try {
			const response = await this.transport(
				`${this.config.baseUrl.replace(/\/$/, "")}/api/project/${this.config.projectId}/${path}`,
				{
					method: body ? "POST" : "GET",
					...(this.config.unixSocket ? { unix: this.config.unixSocket } : {}),
					headers: {
						Authorization: `Bearer ${this.config.token}`,
						"Content-Type": "application/json",
					},
					body: body ? JSON.stringify(body) : undefined,
					redirect: "error",
					signal: AbortSignal.timeout(10_000),
				},
			);
			if (!response.ok) {
				if (body) throw new Error("Workflow submission outcome is unknown");
				return unavailable();
			}
			return await boundedJson(response);
		} catch {
			if (body) throw new Error("Workflow submission outcome is unknown");
			return unavailable();
		}
	}

	async templates(projectId: string) {
		try {
			const raw = z.array(z.unknown()).parse(await this.request("templates"));
			const approved: { template: Template; action: WorkflowAction }[] = [];
			for (const entry of raw) {
				const parsed = templateSchema.safeParse(entry);
				if (!parsed.success) continue;
				const template = parsed.data;
				const action = (Object.keys(playbooks) as WorkflowAction[]).find(
					(key) => playbooks[key] === template.playbook,
				);
				if (
					!action ||
					template.project_id !== this.config.projectId ||
					template.working_directory ||
					(template.arguments && template.arguments !== "[]") ||
					!validActionMetadata(action, template.survey_vars)
				)
					continue;
				if (await this.matchesProject(template, projectId, action))
					approved.push({ template, action });
			}
			return approved;
		} catch {
			return unavailable();
		}
	}

	private async matchesProject(
		template: Template,
		projectId: string,
		action: WorkflowAction,
	) {
		// Require one unambiguous project group; do not guess precedence across secret groups.
		if (template.environment_ids.length !== 1) return false;
		const group = groupSchema.parse(
			await this.request(`environment/${template.environment_ids[0]}`),
		);
		const vars = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(group.json));
		const env = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(group.env || "{}"));
		return (
			group.id === template.environment_ids[0] &&
			group.project_id === this.config.projectId &&
			env.DEMO_PROJECT_ID === projectId &&
			typeof env.DEMO_PROJECT === "string" &&
			/^[a-z][a-z0-9-]{0,23}$/.test(env.DEMO_PROJECT) &&
			!("DEMO_PROJECT_ID" in vars) &&
			!("DEMO_PROJECT" in vars) &&
			!("DEMO_ENROLLMENT_KEY" in env) &&
			!("DEMO_ENROLLMENT_KEY" in vars) &&
			!surveyNames.some(
				(name) => Object.hasOwn(env, name) || Object.hasOwn(vars, name),
			) &&
			(isLoadAction(action) ||
				group.secrets.some(
					(secret) =>
						secret.type === "env" && secret.name === "DEMO_ENROLLMENT_KEY",
				)) &&
			!group.secrets.some(
				(secret) =>
					secret.name === "DEMO_PROJECT_ID" ||
					secret.name === "DEMO_PROJECT" ||
					surveyNames.includes(secret.name),
			)
		);
	}

	async recent(
		projectId: string,
		guard?: TaskLabGuard,
	): Promise<TaskSummary[]> {
		const approved = await this.templates(projectId);
		const tasks = z
			.array(taskSchema)
			.safeParse(await this.request("tasks/last?count=30"));
		if (!tasks.success) return unavailable();
		const visible: TaskSummary[] = [];
		for (const task of tasks.data) {
			const match = approved.find(
				({ template }) => template.id === task.template_id,
			);
			if (
				!match ||
				task.project_id !== this.config.projectId ||
				!this.taskProjectSafe(task.environment) ||
				!this.hasScope(task, projectId, match.action)
			)
				continue;
			try {
				await this.authorizeTaskLab(task, match.action, guard);
			} catch (error) {
				if (
					error instanceof OperationError &&
					["FORBIDDEN", "NOT_FOUND"].includes(error.code)
				)
					continue;
				throw error;
			}
			visible.push({
				id: task.id,
				action: match.action,
				status: task.status,
				created: task.created ?? null,
				...(match.action === "list"
					? {}
					: {
							nativeUrl: `${this.config.uiUrl.replace(/\/$/, "")}/project/${this.config.projectId}/history?t=${task.id}`,
						}),
			});
		}
		return visible;
	}

	private taskProjectSafe(environment: string | null | undefined) {
		try {
			const values = JSON.parse(environment || "{}");
			return (
				values &&
				typeof values === "object" &&
				!Array.isArray(values) &&
				Object.keys(values).every((key) => surveyNames.includes(key))
			);
		} catch {
			return false;
		}
	}

	private async authorizeTaskLab(
		task: z.infer<typeof taskSchema>,
		action: WorkflowAction,
		guard?: TaskLabGuard,
	) {
		if (!isLoadAction(action)) return;
		if (!guard) throw new OperationError("NOT_FOUND", "Task not found");
		const values = z
			.object({
				DEMO_LAB: labSchema,
				DEMO_FLEET: z.enum(["aws-cpu", "gcp-gpu"]).optional(),
			})
			.safeParse(JSON.parse(task.environment || "{}"));
		if (!values.success)
			throw new OperationError("NOT_FOUND", "Task not found");
		await guard(
			values.data.DEMO_LAB,
			workflowFleet(action, values.data.DEMO_FLEET),
		);
	}

	private hasScope(
		task: z.infer<typeof taskSchema>,
		projectId: string,
		action: WorkflowAction,
	) {
		if (!/^recount:[0-9a-f]{64}$/.test(task.message ?? "")) return false;
		const expected = taskScopeMessage(
			this.config.token,
			projectId,
			task.template_id,
			task.environment || "{}",
			action,
		);
		return timingSafeEqual(
			Buffer.from(expected),
			Buffer.from(task.message ?? ""),
		);
	}

	async run(input: WorkflowInput) {
		if (input.action === "create-gpu" && !this.config.gpuEnabled)
			throw new OperationError("FORBIDDEN", "GPU creation is disabled");
		const matches = (await this.templates(input.projectId)).filter(
			({ action }) => action === input.action,
		);
		// Duplicate copies are ambiguous, never select by display name or fall back.
		if (matches.length !== 1) return unavailable();
		const environment = JSON.stringify(survey(input));
		const task = taskSchema.safeParse(
			await this.request("tasks", {
				template_id: matches[0].template.id,
				environment,
				message: taskScopeMessage(
					this.config.token,
					input.projectId,
					matches[0].template.id,
					environment,
					input.action,
				),
			}),
		);
		if (
			!task.success ||
			task.data.project_id !== this.config.projectId ||
			task.data.template_id !== matches[0].template.id
		)
			throw new Error("Workflow submission outcome is unknown");
		return { id: task.data.id };
	}

	async output(projectId: string, taskId: number, guard?: TaskLabGuard) {
		const task = taskSchema.safeParse(await this.request(`tasks/${taskId}`));
		const approved = await this.templates(projectId);
		const match = task.success
			? approved.find(({ template }) => template.id === task.data.template_id)
			: undefined;
		if (
			!task.success ||
			task.data.id !== taskId ||
			task.data.project_id !== this.config.projectId ||
			!this.taskProjectSafe(task.data.environment) ||
			!match ||
			!this.hasScope(task.data, projectId, match.action)
		)
			throw new OperationError("NOT_FOUND", "Task not found");
		await this.authorizeTaskLab(task.data, match.action, guard);
		if (match.action === "list") return "";
		const result = z
			.array(z.object({ output: z.string() }))
			.safeParse(await this.request(`tasks/${taskId}/output`));
		if (!result.success) return unavailable();
		const lines = result.data.map(({ output }) => output);
		const log = redactNativeLog(lines, this.config.token);
		const summary = publicTaskOutput(lines, {
			action: match.action,
			projectId,
			survey: JSON.parse(task.data.environment || "{}"),
		});
		return [log, summary].filter(Boolean).join("\n\n");
	}
}
