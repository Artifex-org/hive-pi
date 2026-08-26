/**
 * Every registered tool is accounted for — enforced, default-deny.
 *
 * `guards-bridge` enforces on tool NAME: it matches `bash`, `edit` and `write`
 * and lets everything else through. So a new tool that writes files or spawns a
 * process is ungoverned unless someone remembers, and for 46 of 47 tools nobody
 * did. That is not a discipline problem, it is a missing check.
 *
 * This is the check. Every extension is loaded against `test/fake-pi.ts`, every
 * `registerTool` is collected, and a tool passes only if it either:
 *
 *   (a) carries a `ToolCapability` declaration (registered via
 *       `registerGuardedTool`), or
 *   (b) appears in READ_ONLY below, which is a REVIEWED list, not a dumping
 *       ground — its diff is the review surface.
 *
 * A new tool matches neither and fails here. Adding a line to READ_ONLY is the
 * deliberate act of saying "this one reads and nothing else", in a diff someone
 * has to approve.
 *
 * Loading all 32 entry points in one vitest module is safe: jiti's
 * per-extension isolation is a pi loader behaviour, not a language one, so here
 * they share a module graph and simply register.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { createFakePi } from "./fake-pi.ts";

const REPO = join(import.meta.dirname, "..");

/**
 * Tools that only read, plus the three the bridge already guards by name.
 *
 * Keep this alphabetical and keep the reasons true. "It has never caused a
 * problem" is not a reason; "its execute performs no write and spawns nothing"
 * is.
 */
const READ_ONLY: Record<string, string> = {
	// Guarded by guards-bridge on NAME — these are pi's built-ins re-registered
	// by pretty-tools purely for rendering, so the bridge still matches them.
	bash: "guards-bridge matches this name (pre-bash hook)",
	edit: "guards-bridge matches this name (decide() on the path)",
	write: "guards-bridge matches this name (decide() on the path)",

	advisor: "one LLM completion; no filesystem, no subprocess",
	agenda_wake: "sets a timer and persists a session entry via pi.appendEntry",
	ask_user_question: "UI only",
	audit_depth: "reads the audit checklist",
	audit_domains: "reads the audit checklist",
	audit_state_read: "reads an audit note",
	background_list: "reads the background extension's own in-memory job registry",
	background_result: "reads one job's retained output from memory",
	bugfix_evidence: "records in-memory protocol state only",
	bugfix_root_cause: "records an in-memory string and restores the tool set",
	compact_schedule: "sets a flag; compaction itself is pi's",
	fetch_content: "network read; has its own SSRF vetting per redirect hop",
	find: "read-only search",
	goal_set: "persists a session entry via pi.appendEntry",
	grep: "read-only search",
	knowledge_collections: "hive knowledge read",
	knowledge_get: "hive knowledge read",
	knowledge_grep: "hive knowledge read",
	knowledge_multi_get: "hive knowledge read",
	knowledge_search: "hive knowledge read",
	list_symbols: "parses a file it reads",
	list_workspace_catalog: "hive API read",
	ls: "read-only listing",
	plan_ask: "returns the question as text",
	plan_ready: "persists a plan entry; leaves read-only mode",
	plan_write: "persists a plan entry via pi.appendEntry",
	read: "read-only",
	read_symbol: "parses a file it reads",
	render_chart: "renders to the terminal",
	report: "worker→parent message; no-op locally",
	TaskCreate: "session-entry state",
	TaskGet: "session-entry state",
	TaskList: "session-entry state",
	TaskUpdate: "session-entry state",
	TodoWrite: "session-entry state",
	web_search: "network read",
	orchestrate_result: "reads the session-local durable-run registry; spawns and writes nothing",
	worker_send: "re-tasks a running worker; spawns nothing",
	workflow_write: "persists a workflow entry via pi.appendEntry; emits a revision on the bus",
};

interface Registered {
	name: string;
	capability?: unknown;
	source: string;
}

/**
 * Extensions that legitimately register NOTHING here, with the reason.
 *
 * An extension that gates itself out registers no tools, so its tools are
 * invisible to this check and escape it — while the suite still reports green.
 * That is the same silent-coverage shape the whole check exists to remove, so
 * it must be stated rather than discovered.
 *
 * Empty is the goal, and it is currently achievable: the two gated extensions
 * (`agmsg`, `hive-remote`) are both STAGED into registering by `fakeHome()`
 * below rather than excused here. Staging beats excusing — an excused
 * extension's tools are ungraded forever, a staged one's are graded like any
 * other.
 */
const REGISTERS_NOTHING_IN_TESTS: Record<string, string> = {};

/**
 * Build a HOME that makes the machine-gated extensions register.
 *
 * Two extensions decide at load whether to exist at all, both by looking at
 * this developer's home directory:
 *
 *   agmsg        `agmsgInstalled()` probes ~/.agents/skills/agmsg/scripts/whoami.sh
 *   hive-remote  `loadConfig().allowAddWorkspace` reads
 *                ~/.pi/agent/hive-telemetry/hive-remote.config.json
 *
 * Both defaults are correct in production — a machine without agmsg should pay
 * nothing for four tools it cannot use, and the workspace grant is deliberately
 * a config edit plus a restart because it hands the agent a new power. But both
 * meant their tools were graded on the author's machine and silently skipped in
 * CI. `list_workspace_catalog` is how that surfaced: it registered locally,
 * did not register in CI, and the stale-READ_ONLY assertion fired there and
 * only there.
 *
 * Staging a HOME rather than reaching past the gates keeps the production
 * behaviour honest — the gates still run, they just have something to find.
 * Nothing is executed: `agmsgInstalled` is an `existsSync`, so the script need
 * not even be runnable, and the agmsg watcher spawns on `session_start`, which
 * this harness never emits.
 */
function fakeHome(): string {
	const home = mkdtempSync(join(tmpdir(), "hive-pi-conformance-"));

	const whoami = join(home, ".agents", "skills", "agmsg", "scripts", "whoami.sh");
	mkdirSync(dirname(whoami), { recursive: true });
	writeFileSync(whoami, "#!/usr/bin/env bash\nexit 0\n");

	const remoteConfig = join(home, ".pi", "agent", "hive-telemetry", "hive-remote.config.json");
	mkdirSync(dirname(remoteConfig), { recursive: true });
	writeFileSync(remoteConfig, JSON.stringify({ allowAddWorkspace: true }));

	// rowtool is opt-in (`raw.enabled === true`), so with no config it registers
	// nothing and this sweep reports it as an extension whose tools it cannot
	// see. Staging the config is this file's own stated preference over an
	// exemption entry: it makes the tool visible so its capability is really
	// graded, rather than excusing it from the grading.
	const rowtoolConfig = join(home, ".pi", "agent", "hive-telemetry", "rowtool.config.json");
	writeFileSync(rowtoolConfig, JSON.stringify({ enabled: true }));

	return home;
}

/**
 * Does this extension register any tool AT ALL, anywhere in its sources?
 *
 * Deliberately not a scan of the entry file alone. That was the first version,
 * and it was vacuous for exactly the extensions it was written to catch: every
 * gated extension here delegates registration to a sibling module
 * (`registerAgmsgTools`, `registerWorkspaceTools`), so `index.ts` contains no
 * literal `registerTool(` and neither one was ever flagged. A check whose blind
 * spot is the case it exists for is worse than no check, because it reads as
 * coverage.
 */
function declaresTools(entry: string): boolean {
	const dir = entry.endsWith("/index.ts") ? `${dirname(entry)}/` : entry;
	const sources = execSync(`git ls-files '${dir}${dir.endsWith("/") ? "**/*.ts" : ""}'`, {
		cwd: REPO,
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean);
	return sources.some((file) => /register(Guarded)?Tool\s*\(/.test(readFileSync(join(REPO, file), "utf8")));
}

let registered: Registered[] = [];
let silentEntries: string[] = [];

/**
 * Loading 32 entry points means transforming the whole extension module graph,
 * which does not fit vitest's 10s default hook timeout — it took ~10s on a warm
 * local cache and blew the budget on a cold CI checkout, so this suite passed
 * locally and failed the gate.
 *
 * A hook timeout does NOT fail loudly in a useful way: the five assertions
 * report as SKIPPED, so the conformance check contributes nothing while the
 * summary still shows a skip rather than a gap. That is the same
 * silent-coverage shape this suite exists to catch, so the budget is generous
 * and explicit. It is still bounded: an extension that genuinely hangs on
 * import fails here rather than wedging the run.
 */
const LOAD_TIMEOUT_MS = 120_000;

beforeAll(async () => {
	// Deterministic registration, without a network call or a credential:
	// `qmd-tools` probes hive and stands down when it answers; `knowledge-tools`
	// registers nothing without hive auth. Both would otherwise make the tool set
	// depend on where the suite runs.
	process.env.QMD_FORCE = "1";
	process.env.HIVE_TELEMETRY_TOKEN ||= "conformance-test-token";
	process.env.HIVE_TELEMETRY_URL ||= "http://127.0.0.1:1";
	// Set before the dynamic imports below: the gated extensions read HOME in
	// their factory, and `guards-bridge` resolves its hook path at module load.
	process.env.HOME = fakeHome();

	const entries = execSync("git ls-files 'extensions/*.ts' 'extensions/*/index.ts'", {
		cwd: REPO,
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean);

	const seen: Registered[] = [];
	const silent: string[] = [];
	for (const entry of entries) {
		const module = (await import(join(REPO, entry))) as { default?: (pi: unknown) => unknown };
		if (typeof module.default !== "function") continue;
		const pi = createFakePi();
		try {
			await module.default(pi.api);
		} catch {
			// An extension that cannot construct in a bare test environment still
			// registered whatever it managed to before throwing; that is what we
			// grade. A load failure is the other suites' business.
		}
		// Only interesting when the source DOES register tools but none appeared:
		// that means the extension gated itself out and its tools are invisible
		// here. An extension that registers no tools at all (hooks, commands,
		// widgets) is not a gap.
		if (pi.tools.length === 0 && declaresTools(entry)) {
			silent.push(entry);
		}
		for (const tool of pi.tools) {
			seen.push({
				name: tool.name,
				capability: (tool.definition as { capability?: unknown }).capability,
				source: entry,
			});
		}
	}
	registered = seen;
	silentEntries = silent;
}, LOAD_TIMEOUT_MS);

describe("tool capability conformance", () => {
	it("loads enough extensions to be meaningful", () => {
		// Guards the test itself: if the glob or the loader breaks, every
		// assertion below passes vacuously.
		expect(registered.length).toBeGreaterThan(25);
	});

	it("accounts for every registered tool — declared, or reviewed read-only", () => {
		const unaccounted = registered
			.filter((tool) => tool.capability === undefined && !(tool.name in READ_ONLY))
			.map((tool) => `${tool.name} (${tool.source})`);

		expect(
			[...new Set(unaccounted)].sort(),
			"a tool must declare what it does via registerGuardedTool, or be added to READ_ONLY " +
				"with a reason. Guards are NOT inherited: guards-bridge matches on tool name, so an " +
				"undeclared tool that writes or spawns is ungoverned.",
		).toEqual([]);
	});

	it("actually covers the machine-gated extensions, rather than passing because they vanished", () => {
		// The negative control for `fakeHome()`. Every assertion in this file is
		// satisfied by a tool that never registers, so "green" is exactly what a
		// broken stage looks like — which is how `list_workspace_catalog` reached
		// CI in the first place. Name the tools that only exist because the stage
		// worked.
		const names = new Set(registered.map((tool) => tool.name));
		for (const gated of ["agmsg_send", "agmsg_inbox", "agmsg_team", "agmsg_history", "list_workspace_catalog", "request_workspace"]) {
			expect(names.has(gated), `${gated} did not register — the staged HOME no longer satisfies its gate, so it is silently ungraded`).toBe(true);
		}
	});

	it("names every extension whose tools this check cannot see", () => {
		// Without this, a gated extension silently drops out of the conformance
		// set and the suite still reports green — the exact failure shape the
		// whole wave is about. Entries with a *hook* but no tools are fine.
		const unexplained = silentEntries.filter((entry) => !(entry in REGISTERS_NOTHING_IN_TESTS));
		expect(
			unexplained.sort(),
			"these registered no tools here. If that is because they register none at all, ignore them; " +
				"if they gate on something the test cannot provide, add them to REGISTERS_NOTHING_IN_TESTS " +
				"so the gap is stated rather than silent.",
		).toEqual([]);
	});

	it("keeps READ_ONLY honest — no entry for a tool that no longer exists", () => {
		// A stale allowlist entry is how a name gets silently re-used later by a
		// tool that does write.
		const names = new Set(registered.map((tool) => tool.name));
		const stale = Object.keys(READ_ONLY).filter((name) => !names.has(name));
		expect(stale, "remove these from READ_ONLY, or restore the tools").toEqual([]);
	});

	it("declares a capability that actually says something", () => {
		for (const tool of registered) {
			if (tool.capability === undefined) continue;
			const capability = tool.capability as {
				writes?: unknown;
				writesResolved?: unknown;
				executes?: unknown;
				writesExemptBecause?: unknown;
			};
			// `writesExemptBecause` must actually SAY something. Accepting any
			// string accepted `""`, which is how a tool could pass a check named
			// "declares a capability that actually says something" while declaring
			// nothing at all — found by an adversarial review of the artifacts
			// extension, whose own test carried the same hole. The exemption is a
			// sentence a reviewer reads; a blank one is an undeclared tool with
			// extra steps.
			const exemption = capability.writesExemptBecause;
			const meaningful =
				(Array.isArray(capability.writes) && capability.writes.length > 0) ||
				typeof capability.writesResolved === "function" ||
				capability.executes === true ||
				(typeof exemption === "string" && exemption.trim().length >= 20);
			expect(meaningful, `${tool.name} declares an empty capability — say what it does, or use READ_ONLY`).toBe(true);
		}
	});
});
