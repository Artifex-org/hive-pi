/**
 * The /security-review pipeline's security PROPERTIES live in role
 * frontmatter, not code — so they get pinned here (HIV-1225): finders and
 * verifiers read untrusted code, and a shell in their tool list is the
 * prompt-injection vector the whole pipeline exists to avoid.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { discoverAgents } from "../extensions/harness/roles.ts";

beforeAll(() => {
	// Same isolation as harness-roles.test.ts: on a developer machine
	// ~/.pi/agent/agents symlinks to these files and would re-label every role.
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "hive-pi-secroles-"));
});

describe("security-review roles", () => {
	const shipped = () => discoverAgents(process.cwd(), "user").agents;

	it("ships both pipeline roles", () => {
		const names = shipped().map((agent) => agent.name);
		expect(names).toContain("security-finder");
		expect(names).toContain("security-verifier");
	});

	it("neither role gets a shell or write tools — they read untrusted code", () => {
		for (const name of ["security-finder", "security-verifier"]) {
			const role = shipped().find((agent) => agent.name === name);
			expect(role, name).toBeDefined();
			const tools = role?.tools ?? [];
			expect(tools.length, `${name} must have an explicit tool list`).toBeGreaterThan(0);
			for (const banned of ["bash", "write", "edit"]) {
				expect(tools, `${name} must not carry ${banned}`).not.toContain(banned);
			}
		}
	});

	it("the verifier is navigation-only — no KB tools to be steered through", () => {
		const verifier = shipped().find((agent) => agent.name === "security-verifier");
		expect(verifier?.tools ?? []).toEqual(["read", "grep", "find", "ls"]);
	});
});
