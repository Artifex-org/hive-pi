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
import { classifyCommand, classifyDiscussionTool, classifyTool } from "../extensions/plan/policy.ts";

describe("the closed set", () => {
	it("is exactly build, plan, discuss, bugfix", () => {
		expect([...OP_MODES]).toEqual(["build", "plan", "discuss", "bugfix"]);
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

/** A compile-time guard: every mode must be handled by the prompt builder. */
describe("exhaustiveness", () => {
	it("builds a prompt result for every mode in the set", () => {
		for (const mode of OP_MODES) {
			const result: string | null = buildOpModePrompt(mode as OpMode);
			expect(result === null || typeof result === "string").toBe(true);
		}
	});
});
