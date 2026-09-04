/**
 * The operating-mode axis: the closed set, and the promises each mode makes.
 *
 * The set itself is asserted because it IS the containment mechanism. If a
 * future change adds "security audit" or "triage" here, the rule in modes.ts was
 * not applied and this test is where that should surface — those are work types
 * that run fine inside `build`, and they already exist as skills.
 */

import { describe, expect, it } from "vitest";
import { setHouseProfileForTest } from "../extensions/profile-common/profile.ts";
import {
	BUGFIX_WITHHELD_TOOLS,
	DEFAULT_OP_MODE,
	isOpMode,
	OP_MODES,
	OP_MODE_ENFORCES,
	type OpMode,
} from "../extensions/opmode/modes.ts";
import { buildOpModePrompt, OP_MODE_MARKER } from "../extensions/opmode/prompt.ts";
import {
	classifyCommand,
	classifyDiscussionTool,
	classifyOrchestrateCommand,
	classifyOrchestrateTool,
	classifyTool,
} from "../extensions/plan/policy.ts";

describe("the closed set", () => {
	it("is exactly build, plan, discuss, bugfix, orchestrate", () => {
		expect([...OP_MODES]).toEqual(["build", "plan", "discuss", "bugfix", "orchestrate"]);
	});

	// Modes are mutually exclusive, so they cap out at a handful. A set that has
	// grown past this is a sign the rule stopped being applied — skills compose,
	// modes do not.
	it("stays small", () => {
		expect(OP_MODES.length).toBeLessThanOrEqual(6);
	});

	it("defaults to the unrestricted posture", () => {
		expect(DEFAULT_OP_MODE).toBe("build");
		expect(isOpMode(DEFAULT_OP_MODE)).toBe(true);
	});

	// Every mode must be able to say what it ENFORCES. A mode that cannot is a
	// skill wearing a mode's clothes (prong 1 of the rule).
	it("gives every mode an enforcement description", () => {
		for (const mode of OP_MODES) {
			expect(OP_MODE_ENFORCES[mode]).toBeTruthy();
		}
	});

	it("rejects anything outside the set", () => {
		for (const bad of ["", "security-audit", "triage", "Plan", "BUILD", "review"]) {
			expect(isOpMode(bad)).toBe(false);
		}
	});
});

describe("prompts", () => {
	it("injects instructions for the modes that need them", () => {
		expect(buildOpModePrompt("discuss")).toContain(OP_MODE_MARKER);
		expect(buildOpModePrompt("bugfix")).toContain(OP_MODE_MARKER);
		expect(buildOpModePrompt("orchestrate")).toContain(OP_MODE_MARKER);
	});

	// `build` restricts nothing, and `plan` is the plan extension's to describe —
	// two prompts for one mode would drift.
	it("injects nothing for build or plan", () => {
		expect(buildOpModePrompt("build")).toBeNull();
		expect(buildOpModePrompt("plan")).toBeNull();
	});

	it("tells discuss mode not to produce a plan or tasks", () => {
		const prompt = buildOpModePrompt("discuss") ?? "";
		expect(prompt).toMatch(/do not produce a plan/i);
	});

	it("tells bugfix mode to reproduce and measure before fixing", () => {
		const prompt = buildOpModePrompt("bugfix") ?? "";
		expect(prompt).toMatch(/reproduce/i);
		expect(prompt).toContain("bugfix_root_cause");
	});

	it("tells orchestrate mode to delegate, validate, and refill capacity", () => {
		const prompt = buildOpModePrompt("orchestrate") ?? "";
		expect(prompt).toMatch(/not an implementer/i);
		expect(prompt).toContain("Factory run");
		expect(prompt).toContain("quality gates");
		expect(prompt).toContain("shared worktree");
		expect(prompt).toContain("root team lead");
		expect(prompt).toContain("squads group peers");
		expect(prompt).toContain("exactly ONE runtime-owner session");
		expect(prompt).toContain("explicit persisted opt-out reason");
		expect(prompt).toContain("end_agent_session");
	});
});

/**
 * The bugfix gate is NARROWER than plan mode's, and that is the design.
 *
 * These assertions exist to stop a well-meaning future change from "hardening"
 * bugfix by routing it through the fail-closed classifier. Doing so would deny
 * bash — and the whole point of the mode is that the agent can build an
 * instrument, run the repro and measure before it is allowed to edit anything.
 */
describe("the bugfix gate", () => {
	it("withholds exactly the file-mutation tools", () => {
		expect([...BUGFIX_WITHHELD_TOOLS].sort()).toEqual(
			["apply_patch", "edit", "multiedit", "notebook_edit", "write"].sort(),
		);
	});

	it("leaves the investigation tools open", () => {
		// bash above all: it is how the agent reproduces, instruments and measures.
		for (const tool of ["bash", "read", "grep", "glob"]) {
			expect(BUGFIX_WITHHELD_TOOLS.has(tool)).toBe(false);
		}
	});

	// The contrast, stated as a test so the difference stays deliberate rather
	// than drifting into accident.
	//
	// Plan mode allows the bash TOOL and then gates the COMMAND — a two-stage
	// check, fail-closed at the second stage, so a mutating command is refused.
	// Bugfix never reaches that second stage at all: its gate is the withheld
	// tool set and nothing else, which is what leaves the shell open for the
	// repro, the instrument and the measurement.
	it("does not inherit plan mode's shell gate", () => {
		expect(classifyTool("bash").allowed).toBe(true);
		expect(classifyCommand("echo boom > /tmp/f").allowed).toBe(false);
		// Nothing shell-shaped is withheld by bugfix, so that command classifier
		// is never consulted in this mode.
		expect(BUGFIX_WITHHELD_TOOLS.has("bash")).toBe(false);
	});
});

/** Discuss mode inherits plan's read-only base and adds reviewed live cards. */
describe("the discuss gate", () => {
	it("denies every file-mutation tool", () => {
		for (const tool of ["edit", "write", "multiedit", "apply_patch"]) {
			expect(classifyTool(tool).allowed).toBe(false);
		}
	});

	it("allows reading", () => {
		for (const tool of ["read", "grep", "glob"]) {
			expect(classifyDiscussionTool(tool, {}).allowed).toBe(true);
		}
	});

	it("allows discovery and a profile-reviewed card, but not MCP scripts or mutations", () => {
		// WHICH cards are reviewed is the house profile's answer. The gate's own
		// rules — discovery is fine, an unlisted tool is not, `mcpScript` never is,
		// an auth action never is — are what this pins.
		setHouseProfileForTest({ readOnlyMcpTools: ["alpha_read_chart", "alpha_deploy_history"] });
		try {
			expect(classifyDiscussionTool("mcp", { search: "chart", server: "alpha" }).allowed).toBe(true);
			expect(classifyDiscussionTool("mcp", { tool: "alpha_read_chart", args: { hours: 24 } }).allowed).toBe(true);
			expect(classifyDiscussionTool("mcp", { tool: "alpha_deploy_history", args: { stack: "prod" } }).allowed).toBe(true);
			expect(classifyDiscussionTool("render_chart", {}).allowed).toBe(true);
			expect(classifyDiscussionTool("mcpScript", { code: "return 1" }).allowed).toBe(false);
			expect(classifyDiscussionTool("mcp", { tool: "alpha_start_trading", args: {} }).allowed).toBe(false);
			expect(classifyDiscussionTool("mcp", { action: "auth-start", tool: "alpha_read_chart" }).allowed).toBe(false);
			expect(classifyDiscussionTool("mcp", undefined).allowed).toBe(false);
			expect(classifyDiscussionTool("mcp", { args: {} }).allowed).toBe(false);
		} finally {
			setHouseProfileForTest(null);
		}
	});

	// The out-of-the-box state: nothing has been reviewed, so no card is
	// pre-approved and discussion mode asks. Conservative, and the only safe
	// default for a server this harness knows nothing about.
	it("pre-approves no MCP card when no profile is configured", () => {
		setHouseProfileForTest({});
		try {
			expect(classifyDiscussionTool("mcp", { tool: "alpha_read_chart", args: {} }).allowed).toBe(false);
			expect(classifyDiscussionTool("mcp", { search: "chart" }).allowed).toBe(true);
		} finally {
			setHouseProfileForTest(null);
		}
	});
});

/** Orchestrate is read-only locally and admits only reviewed coordination mutations. */
describe("the orchestrate gate", () => {
	it("allows inspection, planning, verification, and direct coordination tools", () => {
		for (const tool of ["read", "grep", "plan_write", "workflow_write", "TaskCreate", "quality_gate", "read_ref", "readiness"]) {
			expect(classifyOrchestrateTool(tool, {}).allowed, tool).toBe(true);
		}
	});

	it("allows exact Hive coordination operations through MCP", () => {
		for (const tool of [
			"hive_create_team",
			"hive_create_squad",
			"hive_launch_teammate",
			"hive_message_teammate",
			"hive_offload_to_factory",
			"hive_read_inbox",
			"hive_end_agent_session",
			"hive_wait_for_run",
		]) {
			expect(classifyOrchestrateTool("mcp", { tool, args: {} }).allowed, tool).toBe(true);
		}
	});

	it("allows every Hive tool the lead prompt tells it to call", () => {
		// A mode that denies a tool its own instructions order is a trap: the lead
		// reads "check `list_pulls` before spawning", calls it, and is refused with
		// "delegate implementation instead" — which is not what went wrong.
		// team-lead.md:89 names list_pulls as part of the collision check.
		expect(classifyOrchestrateTool("mcp", { tool: "hive_list_pulls", args: {} }).allowed).toBe(true);
	});

	it("lets the lead FIND a ticket it is already allowed to claim", () => {
		// The same trap as above, in its sharpest form: the mode permitted
		// claim_ticket / comment_ticket / move_ticket_state — WRITES — while
		// refusing the read-only search and preflight that decide whether a claim
		// is appropriate at all. So a lead could claim a ticket it had no
		// sanctioned way to find, or to check was not already somebody else's.
		//
		// Measured 2026-09-04: one orchestrator hit two of these inside sixty
		// seconds and filed both as blocking its ticket vetting.
		for (const tool of ["hive_search_tickets", "hive_get_work_context", "hive_my_tickets"]) {
			expect(classifyOrchestrateTool("mcp", { tool, args: {} }).allowed, tool).toBe(true);
		}
		// The rule is "every READ-ONLY ticket tool", not "anything ticket-shaped".
		// watch_ticket registers a subscription, so it stays denied.
		expect(classifyOrchestrateTool("mcp", { tool: "hive_watch_ticket", args: {} }).allowed).toBe(false);
	});

	it("names printenv when it refuses a command only for its $VAR", () => {
		// `$VAR` is refused wholesale and rightly — the classifier cannot see
		// through an expansion, so `$X` may be any command. But reading an env var
		// is legitimate and read-only, and the refusal named no way to do it, so a
		// lead concluded there was none. `printenv` was on the reader allowlist the
		// whole time. Measured: an orchestrator blocked on
		// `printf '%s\n' "$HIVE_LAUNCH_ID"` doing the documented launch-id lookup.
		const refused = classifyOrchestrateCommand(`printf '%s\\n' "$HIVE_LAUNCH_ID"`);
		expect(refused.allowed).toBe(false);
		if (refused.allowed) return;
		expect(refused.reason).toContain("printenv HIVE_LAUNCH_ID");

		// The sanctioned form really is allowed — otherwise the hint sends the
		// reader into a second refusal.
		expect(classifyOrchestrateCommand("printenv HIVE_LAUNCH_ID").allowed).toBe(true);

		// And a refusal with no expansion in it must not grow a spurious hint.
		const noVar = classifyOrchestrateCommand("rm -rf /tmp/x");
		expect(noVar.allowed).toBe(false);
		if (noVar.allowed) return;
		expect(noVar.reason).not.toContain("printenv");
	});

	it("denies implementation, generic mutation, hidden workers, and auth actions", () => {
		for (const tool of ["edit", "write", "background_bash", "mcpScript", "subagent", "orchestrate"]) {
			expect(classifyOrchestrateTool(tool, {}).allowed, tool).toBe(false);
		}
		expect(classifyOrchestrateTool("mcp", { tool: "hive_trigger_run", args: {} }).allowed).toBe(false);
		expect(classifyOrchestrateTool("mcp", { tool: "linear_create_issue", args: {} }).allowed).toBe(false);
		expect(classifyOrchestrateTool("mcp", { action: "auth-start", server: "hive" }).allowed).toBe(false);
	});

	it("keeps shell access on a strict inspection subset", () => {
		expect(classifyOrchestrateCommand("git diff --stat").allowed).toBe(true);
		expect(classifyOrchestrateCommand("git status --short | wc -l").allowed).toBe(true);
		for (const command of [
			"printf x > src/new.ts",
			"sed '1w /tmp/pwn' input",
			`awk 'BEGIN { print "x" > "/tmp/pwn" }'`,
			"git diff --output=/tmp/pwn",
			"git branch -f main",
			"git remote set-url origin https://example.com/x",
			"git -c core.pager='sh -c touch /tmp/pwn' status",
			"fd -x touch {}",
			"yq --inplace '.x = 1' config.yml",
		]) {
			const denied = classifyOrchestrateCommand(command);
			expect(denied.allowed, command).toBe(false);
			if (!denied.allowed) expect(denied.reason).toContain("Orchestrate mode");
		}
	});
});

/** A compile-time guard: every mode must be handled by the prompt builder. */
describe("exhaustiveness", () => {
	it("builds a prompt result for every mode in the set", () => {
		for (const mode of OP_MODES) {
			const result: string | null = buildOpModePrompt(mode as OpMode);
			expect(result === null || typeof result === "string").toBe(true);
		}
	});
});
