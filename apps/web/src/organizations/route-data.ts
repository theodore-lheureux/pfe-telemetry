import { notFound, redirect } from "@tanstack/react-router";
import type { OperationResult } from "./contracts";
import {
	parseOrganizationReference,
	parseProjectReference,
} from "./validation";

export function routeData<T>(result: OperationResult<T>, returnTo = "/"): T {
	if (!result.error) return result.data;
	if (result.error.code === "UNAUTHENTICATED")
		throw redirect({
			to: "/login",
			search: { redirect: returnTo },
		});
	if (result.error.code === "NOT_FOUND") throw notFound();
	throw new Error(
		result.error.code === "FORBIDDEN"
			? "Verify your email and check your access before continuing."
			: "This page could not be loaded.",
	);
}

export function organizationParams(params: { organizationId: string }) {
	try {
		return parseOrganizationReference(params);
	} catch {
		throw notFound();
	}
}

export function projectParams(params: {
	organizationId: string;
	projectId: string;
}) {
	try {
		return parseProjectReference(params);
	} catch {
		throw notFound();
	}
}
