/**
 * Agent discovery, bound to the running pi.
 *
 * The logic is `roles-core.ts`; this file only supplies pi's own frontmatter
 * parser, agent dir and config dir name, so every in-pi caller keeps the
 * synchronous `discoverAgents(cwd, scope)` it always had.
 */

import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { discoverAgentsWith, type AgentDiscoveryResult, type AgentScope, type RolesRuntime } from "./roles-core.ts";

export * from "./roles-core.ts";

/** pi's runtime, for callers that take a `RolesRuntime` (brief's lanes). */
export const PI_ROLES_RUNTIME: RolesRuntime = {
	parseFrontmatter: (content) => parseFrontmatter<Record<string, unknown>>(content),
	agentDir: getAgentDir,
	configDirName: CONFIG_DIR_NAME,
};

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	return discoverAgentsWith(cwd, scope, PI_ROLES_RUNTIME);
}
