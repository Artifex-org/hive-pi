/**
 * Whether a caller can find out which roles exist.
 *
 * Observed 2026-08-06, in the same failed delegation as the trust gate: the
 * model asked for an agent named "general" — Claude Code's built-in name — for
 * a read-only exploration task the shipped `research` role exists to serve.
 * There is no `general` role here and there should not be one; a name that maps
 * onto "can do anything" cannot be aliased onto a read-only role without
 * silently handing back an agent that cannot write.
 *
 * The defect is that the model had no way to know. The tool description never
 * named a single role, and the unknown-agent error answered with 11 bare slugs
 * and no descriptions — so the guess was uninformed and so was the retry.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createFakePi } from "./fake-pi.ts";
import subagentExtension, { describeAgentForRecovery } from "../extensions/subagent/index.ts";
import { type AgentConfig, discoverAgents } from "../extensions/harness/roles.ts";

beforeAll(() => {
	// Same isolation as harness-roles.test.ts: ~/.pi/agent/agents is a symlink to
	// these very files on a developer's machine, so without this every role comes
	// back labelled `user` and the suite passes in CI while failing locally.
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "hive-pi-discover-"));
});

function registeredSubagentTool() {
	const pi = createFakePi();
	subagentExtension(pi.api);
	const tool = pi.tools.find((t) => t.name === "subagent");
	if (!tool) throw new Error("the subagent extension registered no subagent tool");
	return tool.definition as { description: string };
}

describe("the tool description names the roles a caller may pick", () => {
	it("lists every shipped role", () => {
		// Without this the model has to guess a name from whatever harness it
		// learned on, which is exactly what happened.
		const { description } = registeredSubagentTool();
		const shipped = discoverAgents(process.cwd(), "user").agents;

		expect(shipped.length).toBeGreaterThan(0);
		for (const role of shipped) {
			expect(description, `role ${role.name} is not discoverable from the tool description`).toContain(role.name);
		}
	});

	it("names the alias too, which no other listing surfaces", () => {
		// `explorer` resolves but appears in no listing anywhere — it is invocable
		// and invisible, which is the worst of both.
		expect(registeredSubagentTool().description).toContain("explorer");
	});

	it("stays cheap enough to carry on every turn", () => {
		// The description is paid for the life of the session, so it lists names
		// and aliases only. The prose lives in the unknown-agent error, which only
		// a wrong guess pays for. Guard against someone folding the full
		// descriptions in here later — 11 roles of frontmatter prose is ~1.3 KB.
		expect(registeredSubagentTool().description.length).toBeLessThan(800);
	});
});

describe("the unknown-agent error is answerable", () => {
	const research = discoverAgents(process.cwd(), "user").agents.find((a) => a.name === "research") as AgentConfig;

	it("carries the description a model needs to re-pick", () => {
		expect(research).toBeDefined();
		expect(describeAgentForRecovery(research)).toContain(research.description);
	});

	it("carries the aliases", () => {
		expect(describeAgentForRecovery(research)).toContain("explorer");
	});

	it("says where the role came from", () => {
		// `package` vs `user` vs `project` is how a reader tells a shipped role
		// from one this machine or this repo introduced.
		expect(describeAgentForRecovery(research)).toContain("package");
	});

	it("omits the alias marker for a role that has none", () => {
		const plain: AgentConfig = {
			name: "code-reviewer",
			description: "reviews things",
			systemPrompt: "prompt",
			source: "package",
			filePath: "/tmp/code-reviewer.md",
		};
		expect(describeAgentForRecovery(plain)).not.toContain("aka");
	});
});
