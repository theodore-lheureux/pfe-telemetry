import { m } from "@recount/i18n/messages";
import type { ExecutionNode, ExecutionState } from "./contracts";

/** A node's enrolled hostname, or its ID once it is no longer enrolled. */
export function nodeLabel(node: ExecutionNode) {
	return node.hostname ?? node.id;
}

const STATE_LABEL: Record<ExecutionState, () => string> = {
	running: m.executions_state_running,
	completed: m.executions_state_completed,
};
export function stateLabel(state: ExecutionState) {
	return STATE_LABEL[state]();
}
