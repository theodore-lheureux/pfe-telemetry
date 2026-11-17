import { describe, expect, test } from "bun:test";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	semaphoreConfiguration,
	semaphoreSocketAuthority,
} from "../../src/developer/config.server";
import {
	Semaphore,
	taskScopeMessage,
} from "../../src/developer/semaphore.server";
import { nativeSurvey } from "./developer-template-fixtures";

const environment = {
	RECOUNT_SEMAPHORE_UI_URL: "https://semaphore-ui.invalid",
	RECOUNT_SEMAPHORE_PROJECT_ID: "7",
	RECOUNT_SEMAPHORE_TOKEN: "private-bearer-token",
};
const projectId = "11111111-1111-4111-8111-111111111111";
const routes: Record<string, unknown> = {
	"/api/project/7/templates": [
		{
			id: 4,
			project_id: 7,
			app: "ansible",
			playbook: "infra/demo/create-cpu.yml",
			environment_ids: [9],
			arguments: "[]",
			survey_vars: nativeSurvey("create-cpu"),
		},
	],
	"/api/project/7/environment/9": {
		id: 9,
		project_id: 7,
		json: "{}",
		env: JSON.stringify({ DEMO_PROJECT_ID: projectId, DEMO_PROJECT: "test" }),
		secrets: [{ name: "DEMO_ENROLLMENT_KEY", type: "env" }],
	},
	"/api/project/7/tasks/last": [
		{
			id: 20,
			project_id: 7,
			template_id: 4,
			status: "success",
			environment: "{}",
			message: taskScopeMessage(
				environment.RECOUNT_SEMAPHORE_TOKEN,
				projectId,
				4,
				"{}",
				"create-cpu",
			),
		},
	],
};

describe("Semaphore server-only transport", () => {
	test("requires a separate explicit HTTPS UI URL and exactly one valid transport", () => {
		expect(
			semaphoreConfiguration({
				...environment,
				RECOUNT_SEMAPHORE_URL: "https://api.invalid",
			}),
		).toMatchObject({
			baseUrl: "https://api.invalid",
			uiUrl: environment.RECOUNT_SEMAPHORE_UI_URL,
		});
		expect(
			semaphoreConfiguration({
				...environment,
				RECOUNT_SEMAPHORE_UNIX_SOCKET: "/run/recount/semaphore.sock",
			}),
		).toMatchObject({
			baseUrl: semaphoreSocketAuthority,
			unixSocket: "/run/recount/semaphore.sock",
		});
		for (const changes of [
			{},
			{ RECOUNT_SEMAPHORE_URL: "http://api.invalid" },
			{
				RECOUNT_SEMAPHORE_URL: "https://api.invalid",
				RECOUNT_SEMAPHORE_UI_URL: undefined,
			},
			{
				RECOUNT_SEMAPHORE_UNIX_SOCKET: "/run/recount/semaphore.sock",
				RECOUNT_SEMAPHORE_UI_URL: "http://ui.invalid",
			},
			{
				RECOUNT_SEMAPHORE_UNIX_SOCKET: "/run/recount/semaphore.sock",
				RECOUNT_SEMAPHORE_URL: "https://api.invalid",
			},
			{ RECOUNT_SEMAPHORE_URL: "https://user:password@api.invalid" },
			{ RECOUNT_SEMAPHORE_URL: "https://api.invalid?secret=value" },
			{
				RECOUNT_SEMAPHORE_URL: "https://api.invalid",
				RECOUNT_SEMAPHORE_TOKEN: "token\r\nX-Injected: value",
			},
		])
			expect(semaphoreConfiguration({ ...environment, ...changes })).toBeNull();
	});
	test("rejects relative, noncanonical, control-bearing and oversized socket paths without fallback", () => {
		for (const socket of [
			"",
			"/",
			"relative.sock",
			"/run/../semaphore.sock",
			"/run//semaphore.sock",
			"/run/semaphore.sock/",
			"/run/sem\n.sock",
			"/run/sem\0.sock",
			`/${"a".repeat(107)}`,
		])
			expect(
				semaphoreConfiguration({
					...environment,
					RECOUNT_SEMAPHORE_UNIX_SOCKET: socket,
				}),
			).toBeNull();
	});
	test("socket failures make one fixed-authority request and never retry over the public UI", async () => {
		const config = semaphoreConfiguration({
			...environment,
			RECOUNT_SEMAPHORE_UNIX_SOCKET: "/run/recount/semaphore.sock",
		});
		if (!config) throw new Error("Invalid fixture configuration");
		const calls: { url: string; options: RequestInit & { unix?: string } }[] =
			[];
		const connector = new Semaphore(config, (async (
			url,
			options,
		): Promise<Response> => {
			calls.push({ url: String(url), options: options ?? {} });
			throw new Error(
				`${config.unixSocket} ${config.token} private transport diagnostic`,
			);
		}) as typeof fetch);
		await expect(connector.recent(projectId)).rejects.toMatchObject({
			code: "UNAVAILABLE",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(
			`${semaphoreSocketAuthority}/api/project/7/templates`,
		);
		expect(calls[0].options.unix).toBe(config.unixSocket);
		expect(calls[0].options.redirect).toBe("error");
	});
	test("Bun fetch uses the private Unix socket with bearer auth; only the public UI URL reaches task summaries", async () => {
		const directory = await mkdtemp(join(tmpdir(), "recount-sem-"));
		const socket = join(directory, "api.sock");
		const config = semaphoreConfiguration({
			...environment,
			RECOUNT_SEMAPHORE_UNIX_SOCKET: socket,
		});
		if (!config) {
			await rmdir(directory);
			throw new Error("Invalid fixture socket path");
		}
		const requests: {
			host: string | null;
			authorization: string | null;
			path: string;
		}[] = [];
		const server = Bun.serve({
			unix: socket,
			fetch(request) {
				const path = new URL(request.url).pathname;
				requests.push({
					host: request.headers.get("host"),
					authorization: request.headers.get("authorization"),
					path,
				});
				return Response.json(routes[path] ?? {});
			},
		});
		try {
			const summaries = await new Semaphore(config).recent(projectId);
			expect(summaries).toEqual([
				{
					id: 20,
					action: "create-cpu",
					status: "success",
					created: null,
					nativeUrl: "https://semaphore-ui.invalid/project/7/history?t=20",
				},
			]);
			expect(requests).toHaveLength(3);
			expect(
				requests.every(
					(request) =>
						request.host === "localhost" &&
						request.authorization === `Bearer ${config.token}`,
				),
			).toBe(true);
			const publicData = JSON.stringify(summaries);
			for (const secret of [socket, config.token, semaphoreSocketAuthority])
				expect(publicData).not.toContain(secret);
		} finally {
			await server.stop(true);
			await unlink(socket).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
			await rmdir(directory);
		}
	});
});
