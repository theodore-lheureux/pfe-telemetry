import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultStringifySearch } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { DEFAULT_COLUMNS } from "../../apps/web/src/activity/columns";
import { saveColumns } from "../../apps/web/src/activity/columns.server";
import {
	DEFAULT_DRAFT,
	encodeDraft,
	newSeries,
} from "../../apps/web/src/analytics/insight/draft";
import {
	createEnrollmentKey,
	revokeEnrollmentKey,
	revokeNodes,
} from "../../apps/web/src/collectors/collectors.server";
import {
	closeDatabase,
	getDatabase,
} from "../../apps/web/src/db/client.server";
import { requireOrganization } from "../../apps/web/src/organizations/access.server";
import { createProject } from "../../apps/web/src/organizations/projects.server";

function required(name: string) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const directory = process.argv.includes("--check")
	? ""
	: resolve(required("RECOUNT_GPU_EVIDENCE"));
const actor = { id: required("RECOUNT_GPU_ACTOR_ID") };
const organizationId = required("RECOUNT_GPU_ORGANIZATION_ID");
const database = getDatabase();
try {
	if (process.argv.includes("--check")) {
		await database.transaction(async (tx) => {
			await tx.execute(sql`SET TRANSACTION READ ONLY`);
			const membership = await requireOrganization(tx, actor, organizationId);
			if (!["owner", "admin"].includes(membership.role))
				throw new Error(
					"GPU lab actor must be an existing organization owner/admin",
				);
			const migrations = await tx.execute(sql`
				SELECT hash FROM drizzle.__drizzle_migrations
				WHERE hash = ${required("RECOUNT_GPU_MIGRATION_HASH")}
			`);
			if (migrations.rows.length !== 1)
				throw new Error(
					"The GPU enrollment migration is not applied to this application database",
				);
		});
		console.log(
			"Application database: migration and existing organization admin verified read-only",
		);
	} else if (process.argv.includes("--revoke")) {
		const manifest = await Bun.file(resolve(directory, "project.json")).json();
		const nodeFile = Bun.file(resolve(directory, "node.json"));
		if (await nodeFile.exists()) {
			const node = await nodeFile.json();
			if (node.projectId !== manifest.projectId)
				throw new Error("Refusing cleanup of a node outside the lab project");
			await revokeNodes(database, actor, {
				organizationId,
				projectId: manifest.projectId,
				nodeIds: [node.nodeId],
			});
		}
		await revokeEnrollmentKey(database, actor, {
			organizationId,
			projectId: manifest.projectId,
			enrollmentKeyId: manifest.enrollmentKeyId,
		});
	} else {
		const execution = required("RECOUNT_GPU_EXECUTION");
		const project = await createProject(database, actor, {
			organizationId,
			requestId: randomUUID(),
			name: execution,
		});
		const key = await createEnrollmentKey(database, actor, {
			organizationId,
			projectId: project.id,
			name: execution,
			adapter: "linux",
			maxNodes: 1,
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			labels: ["gpu-e2e"],
		});
		await saveColumns(database, actor, {
			organizationId,
			projectId: project.id,
			columns: [...DEFAULT_COLUMNS, { field: 'attributes["gpu.pipe"]' }],
			asDefault: true,
		});
		await writeFile(resolve(directory, "enrollment.key"), key.key, {
			mode: 0o600,
			flag: "wx",
		});
		const base = `${required("RECOUNT_GPU_WEB_URL")}/organizations/${organizationId}/projects/${project.id}`;
		const views = [
			["pipes", "recount.gpu.pipe.activity", 'attributes["gpu.pipe"]', false],
			[
				"device",
				"recount.gpu.utilization",
				'resource.attributes["gpu.uuid"]',
				false,
			],
			["process-memory", "recount.process.gpu.memory.used", "execution", true],
			[
				"process-utilization",
				"recount.process.gpu.utilization",
				"execution",
				true,
			],
			[
				"pipe-status",
				"recount.collection.read.status",
				'attributes["gpu.pipe"]',
				false,
			],
		] as const;
		const urls = views.map(([name, metric, groupBy, attributed]) => {
			const filters = [];
			if (attributed)
				filters.push({
					field: "execution",
					op: "eq" as const,
					values: [execution],
				});
			if (name === "pipe-status")
				filters.push({
					field: 'attributes["recount.metric.name"]',
					op: "eq" as const,
					values: ["recount.gpu.pipe.activity"],
				});
			const draft = {
				...DEFAULT_DRAFT,
				series: [
					{
						...newSeries("A"),
						metric,
						calculation: "max" as const,
						combine: "max" as const,
					},
				],
				groupBy,
				filters,
				display: { ...DEFAULT_DRAFT.display, type: "table" as const },
			};
			return {
				name,
				url: `${base}/explore${defaultStringifySearch({ q: encodeDraft(draft) })}`,
			};
		});
		await writeFile(
			resolve(directory, "project.json"),
			JSON.stringify(
				{
					projectId: project.id,
					enrollmentKeyId: key.enrollmentKey.id,
					execution,
					projectUrl: base,
					executionUrl: `${base}/executions/${encodeURIComponent(execution)}`,
					views: urls,
				},
				null,
				2,
			),
			{ mode: 0o600, flag: "wx" },
		);
	}
} finally {
	await closeDatabase();
}
