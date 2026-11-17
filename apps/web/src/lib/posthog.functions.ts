import { createServerFn } from "@tanstack/react-start";
import { type PostHogConfig, readPostHogConfig } from "./posthog.server";

// The project token is public: it is sent with every browser event.
const getPostHogConfig = createServerFn().handler(() => readPostHogConfig());

let config: Promise<PostHogConfig | null> | undefined;

/** Reads the settings once per process; analytics stays off if they cannot load. */
export function loadPostHogConfig() {
	config ??= getPostHogConfig().catch(() => {
		config = undefined;
		return null;
	});
	return config;
}
