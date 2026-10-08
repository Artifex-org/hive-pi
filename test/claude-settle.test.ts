/**
 * `hook settle` — the async Stop hook: the status recap and You Should Know,
 * end to end against a fake Hive (session lookup by run id, activity,
 * findings with a recording policy) and a fake pinned pi.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runYouShouldKnow, type SettleDeps } from "../claude/hooks/settle.ts";
import { DEFAULT_CONTROL } from "../claude/state.ts";
import { makeLaunch, runCli, startFakeHive, writeTranscript, type FakeHive, type LaunchEnv } from "./claude-harness.ts";

const RECAP = "Summarize what this coding-agent session just did";
const CAVEAT = "I did not run the migration against production data, so it is unverified.";
const SCANNER = "You surface important information a human might miss";

let launch: LaunchEnv;
let hive: FakeHive;
let transcript: string;

beforeEach(async () => {
	launch = makeLaunch();
	hive = await startFakeHive();
	launch.env.HIVE_URL = hive.url;
	launch.env.HIVE_TOKEN = "session-token";
	transcript = writeTranscript(join(launch.root, "t.jsonl"), [
		{ user: "migrate the orders table" },
		{ assistant: `${"Wrote the migration and its rollback; the schema diff is in the PR description. ".repeat(6)}${CAVEAT}`, id: "assistant-uuid-1" },
	]);
	launch.setReplies([
		{ match: RECAP, text: "migrating orders table; rollback written, prod data untested" },
		{
			match: SCANNER,
			text: JSON.stringify({ notes: [{ kind: "caveat", classification: "context", text: "The migration was never run on production data.", quote: CAVEAT }] }),
		},
	]);
});
afterEach(async () => {
	await hive.close();
});

const settle = () => runCli(["hook", "settle"], launch.env, JSON.stringify({ hook_event_name: "Stop", session_id: "claude-session-1", transcript_path: transcript, cwd: launch.root }));

describe("hook settle", () => {
	it("posts the status recap to the resolved session and uploads grounded findings", async () => {
		const result = await settle();
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(""); // async hook: never a decision

		// HIVE_SESSION_ID is the run id; the uuid comes from by-run, with the launch's bearer.
		const byRun = hive.requests.find((r) => r.path === "/api/v1/agent-sessions/by-run/run-123");
		expect(byRun?.auth).toBe("Bearer session-token");
		const activity = hive.requests.find((r) => r.path === "/api/v1/agent-sessions/srv-uuid-1/activity");
		expect(activity?.method).toBe("POST");
		expect(activity?.body).toMatchObject({ phase: "idle", recap: "migrating orders table; rollback written, prod data untested" });
		expect(typeof (activity?.body as { since?: unknown }).since).toBe("string");

		const upload = hive.requests.find((r) => r.method === "POST" && r.path.endsWith("/you-should-know/findings"));
		expect(upload?.path).toBe("/api/v1/agent-sessions/srv-uuid-1/you-should-know/findings");
		const body = upload?.body as { recording: boolean; recording_revision: number; findings: Record<string, unknown>[] };
		expect(body.recording).toBe(true);
		expect(body.recording_revision).toBe(2);
		expect(body.findings).toHaveLength(1);
		expect(body.findings[0]).toMatchObject({ kind: "caveat", quote: CAVEAT, source_id: "assistant-uuid-1", source_type: "assistant", provenance: "assistant_reported" });

		const scan = launch.calls().find((c) => c.input.includes(SCANNER));
		expect(scan?.argv).toContain("--append-system-prompt");
		expect(scan?.argv[scan.argv.indexOf("--thinking") + 1]).toBe("off");
		expect(scan?.argv[scan.argv.indexOf("--model") + 1]).toBe("zai/glm-low");

		const roles = launch.spoolRecords().filter((r) => r.kind === "usage").map((r) => r.role);
		expect(roles.sort()).toEqual(["recap", "ysk"]);
		const state = JSON.parse(readFileSync(join(launch.stateDir, "ysk.json"), "utf8"));
		expect(state.scans).toBe(1);
		expect(state.offset).toBe(readFileSync(transcript).length);
		expect(state.seen).toHaveLength(1);
	});

	it("skips Hive posts while the session is not attached, keeping the YSK cursor for later", async () => {
		hive.sessionId = null;
		const result = await settle();
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("does not resolve on Hive yet");
		expect(hive.requests.some((r) => r.path.endsWith("/activity"))).toBe(false);
		expect(hive.requests.some((r) => r.path.endsWith("/you-should-know/findings"))).toBe(false);
		expect(launch.calls().some((c) => c.input.includes(SCANNER))).toBe(false);
	});

	it("does not scan when the driver turned YSK off", async () => {
		launch.writeControl({ opMode: "build", ysk: { enabled: false } });
		await settle();
		expect(launch.calls().some((c) => c.input.includes(SCANNER))).toBe(false);
	});

	it("applies the driver's recording control at its revision — recording off means nothing is uploaded", async () => {
		launch.writeControl({ opMode: "build", ysk: { enabled: true, recording: false, recordingRevision: 3 } });
		const result = await settle();
		expect(result.code).toBe(0);
		expect(launch.calls().some((c) => c.input.includes(SCANNER))).toBe(true);
		expect(hive.requests.some((r) => r.method === "POST" && r.path.endsWith("/you-should-know/findings"))).toBe(false);
	});

	it("says once that it is off without a leased store", async () => {
		delete launch.env.HIVE_PI_AGENT_DIR;
		const result = await settle();
		expect(result.code).toBe(0);
		expect(result.stderr.trim().split("\n")).toHaveLength(1);
		expect(result.stderr).toContain("no outside-model credential");
		expect(hive.requests).toHaveLength(0);
	});
});

describe("You Should Know limits", () => {
	function deps(overrides: Partial<SettleDeps> = {}): SettleDeps {
		return {
			stateDir: launch.stateDir,
			control: DEFAULT_CONTROL,
			auth: { url: hive.url, token: "t" },
			session: async () => ({ ok: true, id: "srv-uuid-1" }),
			resolveYskModel: async () => ({ ok: true, pick: { spec: "zai/glm-low", source: "mode:low" } }),
			resolveEvaluator: async () => ({ ok: true, pick: { spec: "zai/glm-low", source: "mode:low" } }),
			oneShot: () => async () => {
				throw new Error("no model call expected");
			},
			stderr: () => {},
			...overrides,
		};
	}

	it("waits out the 30 s interval before scanning again", async () => {
		const now = 1_000_000;
		writeFileSync(join(launch.stateDir, "ysk.json"), JSON.stringify({ offset: 0, scans: 1, lastStart: now - 10_000, seen: [] }));
		const waited: number[] = [];
		await runYouShouldKnow(
			{ transcript_path: transcript, cwd: launch.root },
			deps({
				now: () => now,
				sleep: async (ms) => {
					waited.push(ms);
					throw new Error("stop after the wait");
				},
			}),
		).catch((error: Error) => expect(error.message).toBe("stop after the wait"));
		expect(waited).toEqual([20_000]);
	});

	it("stops at 20 scans per session", async () => {
		writeFileSync(join(launch.stateDir, "ysk.json"), JSON.stringify({ offset: 0, scans: 20, lastStart: 0, seen: [] }));
		await runYouShouldKnow({ transcript_path: transcript, cwd: launch.root }, deps());
		expect(JSON.parse(readFileSync(join(launch.stateDir, "ysk.json"), "utf8")).scans).toBe(20);
	});
});
