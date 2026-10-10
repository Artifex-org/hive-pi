import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preToolDecision } from "../claude/hooks/pre-tool.ts";
import { DEFAULT_CONTROL } from "../claude/state.ts";
import { nativeMcpToolName } from "../extensions/mcp-common/names.ts";
import { READ_ONLY_MCP_TOOLS, classifyDiscussionTool, classifyOrchestrateTool, classifyTool, planToolVerdict, type PlanToolVerdict } from "../extensions/plan/policy.ts";
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

	it("refuses the ten mutating Hive tools in discussion, and the four orchestrate does not coordinate", () => {
		// Explicit inventories, not derived from the classifier under test.
		const mutations = ["trigger_run", "cancel_run", "claim_ticket", "comment_ticket", "launch_teammate", "steer_agent", "set_queue_concurrency", "set_cluster_labels", "knowledge_write", "create_communication"];
		const orchestrateRefused = ["trigger_run", "set_queue_concurrency", "set_cluster_labels", "knowledge_write"];
		const refusals: [string, (name: string, input: unknown) => PlanToolVerdict, string[], string][] = [
			["discuss", classifyDiscussionTool, mutations, "Discussion mode permits only reviewed read-only MCP tools"],
			["orchestrate", classifyOrchestrateTool, orchestrateRefused, "Orchestrate mode does not permit MCP tool"],
		];
		for (const [mode, classify, tools, reason] of refusals) {
			const opMode = mode as "discuss" | "orchestrate";
			for (const tool of tools) {
				for (const name of [`hive_${tool}`, nativeMcpToolName("hive", tool)]) {
					expect(classify(name, {}).allowed, `${mode} direct: ${name}`).toBe(false);
					const gateway = classify("mcp", { tool: name, args: {} });
					expect(gateway.allowed === false && gateway.reason, `${mode} gateway: ${name}`).toContain(reason);
					const hookName = name.startsWith("mcp__") ? name : `mcp__hive-pi__${name}`;
					for (const [tool_name, tool_input] of [[hookName, {}], ["mcp__hive-pi__mcp", { tool: name, args: {} }]] as const) {
						expect(preToolDecision({ tool_name, tool_input }, { ...DEFAULT_CONTROL, opMode }), `${mode} hook ${tool_name}: ${name}`).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
					}
				}
			}
		}
		// Positive control: orchestrate's coordination list really admits the other six.
		for (const tool of mutations.filter((tool) => !orchestrateRefused.includes(tool))) {
			expect(classifyOrchestrateTool("mcp", { tool: `hive_${tool}` }).allowed, tool).toBe(true);
		}
	});

	it("honours profile grants only through the discussion/orchestrate gateway, never direct or in plan", () => {
		const grants = ["mcp__hive_get__run", "mcp__hive_knowledge__search", "mcp__linear_get__issue", "alpha_read_metrics", "mcp__alpha__read_metrics"];
		setHouseProfileForTest({ readOnlyMcpTools: grants });
		for (const name of grants) {
			for (const [mode, classify] of Object.entries(readModes)) {
				const opMode = mode as "plan" | "discuss" | "orchestrate";
				expect(classify(name, {}).allowed, `${mode}: ${name}`).toBe(false);
				expect(preToolDecision({ tool_name: name, tool_input: {} }, { ...DEFAULT_CONTROL, opMode }), `${mode} hook: ${name}`).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
				const gateway = preToolDecision({ tool_name: "mcp__hive-pi__mcp", tool_input: { tool: name, args: {} } }, { ...DEFAULT_CONTROL, opMode });
				if (mode === "plan") {
					expect(classify("mcp", { tool: name, args: {} }).allowed, `${mode} gateway: ${name}`).toBe(false);
					expect(gateway, `${mode} gateway hook: ${name}`).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
					continue;
				}
				// A lookalike spelling of a fixed read through the gateway takes that
				// reviewed binding; a native-form grant pins its declared server; the
				// open `server_tool` grant leaves the server to the gateway.
				const expected: Record<string, Record<string, unknown>> = {
					mcp__hive_get__run: { tool: "hive_get_run", server: "hive_get", args: {} },
					mcp__hive_knowledge__search: { tool: "hive_knowledge_search", server: "hive_knowledge", args: {} },
					mcp__linear_get__issue: { tool: "linear_get_issue", server: "linear_get", args: {} },
					alpha_read_metrics: { tool: "alpha_read_metrics", args: {} },
					mcp__alpha__read_metrics: { tool: "alpha_read_metrics", args: {} },
				};
				const open = !("server" in expected[name]);
				expect(classify("mcp", { tool: name, args: {} }), `${mode} gateway: ${name}`).toEqual({ allowed: true, updatedInput: expected[name], ...(open ? { uniqueServer: true } : {}) });
				expect(gateway, `${mode} gateway hook: ${name}`).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: expected[name] } });
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

	it("keeps discussion cards/waits, profile grants and orchestrate coordination out of plan", () => {
		setHouseProfileForTest({ readOnlyMcpTools: ["mcp__alpha__read_metrics"] });
		for (const name of ["hive_wait_for_run", "mcp__hive__wait_for_run", "alpha_read_metrics", "mcp__alpha__read_metrics"]) {
			expect(planToolVerdict(name, {}).allowed, name).toBe(false);
			expect(planToolVerdict("mcp", { tool: name }).allowed, name).toBe(false);
			for (const classify of [classifyDiscussionTool, classifyOrchestrateTool]) {
				expect(classify(name, {}).allowed, name).toBe(false);
				expect(classify("mcp", { tool: name, server: name.includes("alpha") ? "alpha" : "hive" }).allowed, name).toBe(true);
			}
		}
		for (const name of ["hive_claim_ticket", "hive_launch_teammate", "mcp__hive__steer_agent", "mcp__linear__save_comment"]) {
			expect(classifyDiscussionTool(name, {}).allowed, name).toBe(false);
			expect(classifyOrchestrateTool(name, {}).allowed, name).toBe(false);
			expect(classifyOrchestrateTool("mcp", { tool: name }).allowed, name).toBe(true);
		}
	});

	it("pins native-form profile grants to their declared server and leaves open grants to the gateway", () => {
		const native = "mcp__alpha_ops__read_metrics";
		for (const [mode, classify] of Object.entries({ discuss: classifyDiscussionTool, orchestrate: classifyOrchestrateTool })) {
			const opMode = mode as "discuss" | "orchestrate";
			setHouseProfileForTest({ readOnlyMcpTools: [native] });
			// Direct spellings never prove a raw pair.
			for (const direct of [native, "alpha_ops_read_metrics", "mcp__alpha__ops_read_metrics"]) {
				expect(classify(direct, {}).allowed, `${mode}: ${direct}`).toBe(false);
				expect(preToolDecision({ tool_name: direct, tool_input: {} }, { ...DEFAULT_CONTROL, opMode })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
			}
			for (const input of [{ tool: native }, { tool: "alpha_ops_read_metrics" }, { tool: "mcp__alpha__ops_read_metrics" }, { tool: "alpha_ops_read_metrics", server: "alpha_ops" }]) {
				expect(classify("mcp", input), `${mode}: ${JSON.stringify(input)}`).toEqual({ allowed: true, updatedInput: { ...input, tool: "alpha_ops_read_metrics", server: "alpha_ops" } });
			}
			// The declared server is the only one: a different prefix is not the reviewed tool.
			for (const server of ["alpha", "beta", "alpha_ops_read_metrics", "alpha_ops_", "", 1, null]) {
				expect(classify("mcp", { tool: "alpha_ops_read_metrics", server }).allowed, `${mode} server ${String(server)}`).toBe(false);
			}
			expect(classify("mcp", { tool: "alpha_ops_read_metrics_extra" }).allowed, `${mode} near miss`).toBe(false);

			// The open `server_tool` form names no boundary: any real prefix is
			// admitted here, and the gateway binds the one configured owner.
			setHouseProfileForTest({ readOnlyMcpTools: ["alpha_ops_read_metrics"] });
			for (const input of [{ tool: "alpha_ops_read_metrics" }, { tool: "alpha_ops_read_metrics", server: "alpha" }, { tool: "alpha_ops_read_metrics", server: "alpha_ops" }]) {
				expect(classify("mcp", input), `${mode} open: ${JSON.stringify(input)}`).toEqual({ allowed: true, updatedInput: { ...input, tool: "alpha_ops_read_metrics" }, uniqueServer: true });
			}
			expect(classify("mcp", { tool: "alpha_ops_read_metrics", server: "beta" }).allowed).toBe(false);
		}
		expect(planToolVerdict(native, {}).allowed).toBe(false);
		expect(planToolVerdict("mcp", { tool: native }).allowed).toBe(false);
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
