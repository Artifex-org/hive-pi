import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preToolDecision } from "../claude/hooks/pre-tool.ts";
import { DEFAULT_CONTROL } from "../claude/state.ts";
import { nativeMcpToolName } from "../extensions/mcp-common/names.ts";
import { READ_ONLY_MCP_TOOLS, classifyDiscussionTool, classifyOrchestrateTool, classifyTool, planToolVerdict } from "../extensions/plan/policy.ts";
import { setHouseProfileForTest } from "../extensions/profile-common/profile.ts";
import { makeLaunch, REPO, runCli } from "./claude-harness.ts";

// Acceptance inventory independent of the implementation: removing a required
// read from the set must fail, not silently shrink a test derived from that set.
const hiveReads = [
	"get_ticket", "search_tickets", "find_related_work", "get_work_context", "get_board", "my_tickets",
	"get_occupancy", "list_communications", "get_communication",
	"knowledge_search", "knowledge_grep", "knowledge_get", "knowledge_multi_get", "knowledge_collections",
	"list_clusters", "fleet_status", "list_queues", "get_scheduler_settings", "get_topology", "get_constraint_cost", "get_queue_wait", "get_step_durations",
	"list_runs", "get_run", "get_run_tests", "get_run_reports", "get_task_logs", "explain_failure",
	"get_test_pg_health", "get_deploy_status", "get_readiness", "list_projects", "get_pull", "list_pulls",
];
const linearReads = ["get_issue", "list_issues", "list_comments"];
const reads = [...hiveReads.map((tool) => ["hive", tool]), ...linearReads.map((tool) => ["linear", tool])];
const hiveWrites = [
	"trigger_run", "cancel_run", "claim_ticket", "comment_ticket", "launch_teammate", "steer_agent",
	"set_queue_concurrency", "set_cluster_labels", "knowledge_write", "create_communication",
	// Names that look observational but mint a session, consume inbox state or subscribe.
	"whoami", "read_inbox", "watch_ticket", "new_unknown_tool", "get_unknown_state",
];
const readModes = { plan: planToolVerdict, discuss: classifyDiscussionTool, orchestrate: classifyOrchestrateTool };

beforeEach(() => setHouseProfileForTest({}));
afterEach(() => setHouseProfileForTest(null));

describe("reviewed live research in read-only modes", () => {
	it("uses one exact, complete canonical inventory in every mode and envelope", () => {
		expect([...READ_ONLY_MCP_TOOLS].sort()).toEqual(reads.map(([server, tool]) => `${server}_${tool}`).sort());
		for (const [server, tool] of reads) {
			for (const name of [`${server}_${tool}`, nativeMcpToolName(server, tool)]) {
				expect(classifyTool(name).allowed, name).toBe(false);
				for (const [mode, classify] of Object.entries(readModes)) {
					expect(classify(name, {}).allowed, `${mode}: ${name}`).toBe(false);
					expect(classify("mcp", { tool: name, args: {} }).allowed, `${mode} gateway: ${name}`).toBe(true);
					expect(classify("mcp", { tool: name, server, args: {} }).allowed, `${mode} explicit server: ${name}`).toBe(true);
					expect(preToolDecision({ tool_name: "mcp__hive-pi__mcp", tool_input: { tool: name, args: {} } }, { ...DEFAULT_CONTROL, opMode: mode as "plan" | "discuss" | "orchestrate" }), `${mode} gateway hook: ${name}`).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { tool: `${server}_${tool}`, server, args: {} } } });
					// Claude's promoted native names and hive-pi adapter passthrough.
					const hookName = name.startsWith("mcp__") ? name : `mcp__hive-pi__${name}`;
					const direct = preToolDecision({ tool_name: hookName, tool_input: {} }, { ...DEFAULT_CONTROL, opMode: mode as "plan" | "discuss" | "orchestrate" });
					expect(direct, `${mode} direct: ${hookName}`).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
				}
			}
		}
	});

	it("denies mutations, unknowns and lookalike servers directly and through the plan gateway/hook", () => {
		const denied = [
			...hiveWrites.flatMap((tool) => [`hive_${tool}`, nativeMcpToolName("hive", tool)]),
			"linear_save_issue", "mcp__linear__save_comment", "mcp__linear__delete_issue",
			"mcp__other__get_run", "mcp__other__knowledge_search", "hive_get_run_extra", "unknown_tool", "mcpScript",
			"mcp__hive_get__run", "mcp__hive_knowledge__search", "mcp__linear_get__issue",
		];
		for (const name of denied) {
			expect(planToolVerdict(name, {}).allowed, name).toBe(false);
			expect(planToolVerdict("mcp", { tool: name }).allowed, `gateway: ${name}`).toBe(false);
			const hookName = name.startsWith("mcp__") ? name : `mcp__hive-pi__${name}`;
			for (const [tool_name, tool_input] of [[hookName, {}], ["mcp__hive-pi__mcp", { tool: name }]] as const) {
				expect(preToolDecision({ tool_name, tool_input }, { ...DEFAULT_CONTROL, opMode: "plan" }), tool_name).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
			}
		}
	});

	it("denies profile-granted canonical, native and direct aliases in every read-only mode", () => {
		setHouseProfileForTest({ readOnlyMcpTools: ["mcp__hive_get__run", "mcp__hive_knowledge__search", "mcp__linear_get__issue", "alpha_read_metrics", "mcp__alpha__read_metrics"] });
		for (const name of ["mcp__hive_get__run", "mcp__hive_knowledge__search", "mcp__linear_get__issue", "alpha_read_metrics", "mcp__alpha__read_metrics"]) {
			for (const [mode, classify] of Object.entries(readModes)) {
				expect(classify(name, {}).allowed, `${mode}: ${name}`).toBe(false);
				expect(classify("mcp", { tool: name, args: {} }).allowed, `${mode} gateway: ${name}`).toBe(false);
				expect(preToolDecision({ tool_name: name, tool_input: {} }, { ...DEFAULT_CONTROL, opMode: mode as "plan" | "discuss" | "orchestrate" }), `${mode} hook: ${name}`).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
			}
		}
	});

	it("returns a dispatch binding without mutating the classifier input", () => {
		const input = Object.freeze({ tool: "mcp__hive__get_run", args: { run_id: "42" } });
		for (const classify of Object.values(readModes)) {
			expect(classify("mcp", input)).toEqual({ allowed: true, updatedInput: { tool: "hive_get_run", server: "hive", args: input.args } });
			expect(input).toEqual({ tool: "mcp__hive__get_run", args: { run_id: "42" } });
		}
	});

	it("validates gateway envelopes and action precedence rather than trusting a safe-looking tool field", () => {
		for (const [mode, classify] of Object.entries(readModes)) {
			expect(preToolDecision({ tool_name: "mcp__hive-pi__mcp", tool_input: { tool: "hive_get_run", server: "hive_get" } }, { ...DEFAULT_CONTROL, opMode: mode as "plan" | "discuss" | "orchestrate" }), `${mode} conflicting server hook`).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
			for (const input of [undefined, null, [], "hive_get_run", { tool: 1 }, { tool: null }, { tools: ["hive_get_run"] }, { tool: "hive_get_run", action: "login" }, { tool: "hive_get_run", server: "hive_get" }, { tool: "hive_get_run", server: null }, { tool: "mcp__linear__get_issue", server: "hive" }]) {
				expect(classify("mcp", input).allowed, JSON.stringify(input)).toBe(false);
			}
			expect(classify("mcp", { search: "hive", includeSchemas: true }).allowed).toBe(false);
			expect(classify("mcp", { action: "ui-messages" }).allowed).toBe(false);
		}
	});

	it("keeps fixed discussion cards/waits and orchestrate coordination without promoting them into plan", () => {
		setHouseProfileForTest({ readOnlyMcpTools: ["mcp__alpha__read_metrics"] });
		for (const name of ["hive_wait_for_run", "mcp__hive__wait_for_run", "alpha_read_metrics", "mcp__alpha__read_metrics"]) {
			expect(planToolVerdict(name, {}).allowed, name).toBe(false);
			expect(planToolVerdict("mcp", { tool: name }).allowed, name).toBe(false);
			for (const classify of [classifyDiscussionTool, classifyOrchestrateTool]) {
				expect(classify(name, {}).allowed, name).toBe(false);
				expect(classify("mcp", { tool: name, server: name.includes("alpha") ? "alpha" : "hive" }).allowed, name).toBe(name.includes("wait_for_run"));
			}
		}
		for (const name of ["hive_claim_ticket", "hive_launch_teammate", "mcp__hive__steer_agent", "mcp__linear__save_comment"]) {
			expect(classifyDiscussionTool(name, {}).allowed, name).toBe(false);
			expect(classifyOrchestrateTool(name, {}).allowed, name).toBe(false);
			expect(classifyOrchestrateTool("mcp", { tool: name }).allowed, name).toBe(true);
		}
	});

	it("denies profile entries rather than inferring server boundaries", () => {
		setHouseProfileForTest({ readOnlyMcpTools: ["mcp__alpha_ops__read_metrics"] });
		const native = "mcp__alpha_ops__read_metrics";
		for (const [mode, classify] of Object.entries({ discuss: classifyDiscussionTool, orchestrate: classifyOrchestrateTool })) {
			expect(classify(native, {}).allowed).toBe(false);
			expect(classify("alpha_ops_read_metrics", {}).allowed).toBe(false);
			expect(classify("mcp", { tool: native, args: {} }).allowed).toBe(false);
			expect(classify("mcp", { tool: "alpha_ops_read_metrics", server: "alpha_ops", args: {} }).allowed).toBe(false);
			expect(classify("mcp", { tool: "alpha_ops_read_metrics", args: {} }).allowed).toBe(false);
			expect(classify("mcp__alpha__ops_read_metrics", {}).allowed).toBe(false);
			expect(classify("mcp", { tool: "mcp__alpha__ops_read_metrics", server: "alpha", args: {} }).allowed).toBe(false);
			expect(classify("mcp", { tool: "alpha_ops_read_metrics", server: "alpha", args: {} }).allowed).toBe(false);
			expect(classify("mcp", { tool: native, server: "alpha", args: {} }).allowed).toBe(false);
			expect(preToolDecision({ tool_name: native, tool_input: {} }, { ...DEFAULT_CONTROL, opMode: mode as "discuss" | "orchestrate" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
			expect(preToolDecision({ tool_name: "mcp__hive-pi__mcp", tool_input: { tool: native, args: {} } }, { ...DEFAULT_CONTROL, opMode: mode as "discuss" | "orchestrate" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
		}
		expect(planToolVerdict(native, {}).allowed).toBe(false);
		for (const ambiguous of ["mcp__alpha__ops__read_metrics", "mcp__alpha___read_metrics", "mcp__alpha__read_metrics_"]) {
			setHouseProfileForTest({ readOnlyMcpTools: [ambiguous] });
			for (const classify of [classifyDiscussionTool, classifyOrchestrateTool]) {
				expect(classify(ambiguous, {}).allowed).toBe(false);
				expect(classify("mcp", { tool: ambiguous }).allowed).toBe(false);
				expect(classify("mcp", { tool: ambiguous, server: "alpha__ops" }).allowed).toBe(false);
			}
		}
		setHouseProfileForTest({ readOnlyMcpTools: ["alpha_ops_read_metrics"] });
		for (const classify of [classifyDiscussionTool, classifyOrchestrateTool]) {
			expect(classify(native, {}).allowed).toBe(false);
			expect(classify("mcp", { tool: "alpha_ops_read_metrics", server: "alpha_ops" }).allowed).toBe(false);
		}
	});

	it("allows kickoff context and harness knowledge wrappers, never session pivots or content writes", () => {
		for (const name of ["session_context", "knowledge_search", "knowledge_grep", "knowledge_get", "knowledge_multi_get", "knowledge_collections"]) {
			expect(planToolVerdict(name, {}).allowed, name).toBe(true);
			expect(preToolDecision({ tool_name: `mcp__hive-pi__${name}`, tool_input: {} }, { ...DEFAULT_CONTROL, opMode: "plan" }), name).toBeNull();
		}
		for (const name of ["session_title", "knowledge_write"]) expect(planToolVerdict(name, {}).allowed, name).toBe(false);
	});

	it("denies direct CLI reads, binds gateways without granting permission, and denies mutations", async () => {
		const launch = makeLaunch();
		launch.writeControl({ opMode: "plan" });
		for (const [tool_name, tool_input, allowed] of [
			["mcp__hive__get_ticket", {}, false],
			["mcp__linear__get_issue", {}, false],
			["mcp__hive-pi__mcp", { tool: "hive_knowledge_search", args: {} }, true],
			["mcp__hive__knowledge_write", {}, false],
			["mcp__hive-pi__mcp", { tool: "hive_trigger_run" }, false],
		] as const) {
			const result = await runCli(["hook", "pre-tool"], launch.env, JSON.stringify({ tool_name, tool_input }), REPO);
			expect(result.code, tool_name).toBe(0);
			if (allowed && tool_name === "mcp__hive-pi__mcp") expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...tool_input, tool: "hive_knowledge_search", server: "hive" } } });
			else if (allowed) expect(result.stdout, tool_name).toBe("");
			else expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
		}
	});
});
