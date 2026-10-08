/**
 * The Claude adapter's small pieces: the spool's record contract, the Claude
 * transcript translation, the leased-provider model choice, and the
 * process-group kill pi children get in a Claude launch.
 */

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { recapTranscript } from "../extensions/agenda/recap.ts";
import { createGatePolicy } from "../extensions/agenda/gate.ts";
import { emptyLedger } from "../extensions/agenda/ledger.ts";
import { getPiInvocation } from "../extensions/agenda/spawn.ts";
import { turnFailureOf } from "../extensions/agenda/turn-outcome.ts";
import { tryLock } from "../claude/state.ts";
import { classifyHandback } from "../extensions/hive-common/handback.ts";
import { killTree, treeSpawnOptions } from "../extensions/hive-common/child-tree.ts";
import { cheapLaneMode } from "../extensions/subagent/model.ts";
import { isConfiguredWith } from "../claude/models.ts";
import { createSpool, fitWakeText, MAX_RECORD_BYTES } from "../claude/spool.ts";
import { readAppendedLines, toPiEntries, withFinalAssistant } from "../claude/transcript.ts";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "claude-units-"));
}

describe("spool", () => {
	it("writes the driver's record shapes, integers where it wants integers", () => {
		const path = join(tmp(), "spool.jsonl");
		const spool = createSpool(path, () => {});
		spool.usage("goal-judge", "zai/glm-low", { input: 10.6, output: 2, cacheRead: 0, cacheWrite: 1, cost: 0.002 }, 1234.7, 1);
		spool.gate("drift", "timed_out", 60_000.4);
		spool.wake("sub-1-abcd1234", "done");
		const records = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(records[0]).toMatchObject({ v: 1, kind: "usage", role: "goal-judge", model: "zai/glm-low", input: 11, output: 2, cacheRead: 0, cacheWrite: 1, cost: 0.002, turns: 1, ms: 1235 });
		expect(records[1]).toMatchObject({ v: 1, kind: "gate", gate: "drift", outcome: "timed_out", ms: 60000 });
		expect(records[2]).toMatchObject({ v: 1, kind: "wake", source: "subagent", job: "sub-1-abcd1234", text: "done" });
		for (const r of records) expect(Number.isNaN(Date.parse(r.at))).toBe(false);
	});

	it("does not write a usage record the driver would drop, and says why", () => {
		const path = join(tmp(), "spool.jsonl");
		const said: string[] = [];
		const spool = createSpool(path, (l) => said.push(l));
		spool.usage("x", "no-provider", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, 1);
		spool.usage("x", "zai/glm", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: Number.NaN }, 1);
		expect(said).toHaveLength(2);
		expect(() => readFileSync(path)).toThrow();
	});

	it("keeps a wake record under 4 KiB whatever the text", () => {
		const text = "ü€".repeat(5_000);
		const fitted = fitWakeText("sub-1", text);
		const line = JSON.stringify({ v: 1, kind: "wake", source: "subagent", job: "sub-1", text: fitted, at: new Date().toISOString() });
		expect(Buffer.byteLength(`${line}\n`)).toBeLessThan(MAX_RECORD_BYTES);
		expect(fitted.endsWith("[truncated]")).toBe(true);
	});

	it("refuses a job id the driver could never match", () => {
		const spool = createSpool(join(tmp(), "s.jsonl"), () => {});
		expect(() => spool.wake("bad id!", "x")).toThrow(/job id/);
	});

	it("says once, and writes nothing, without HIVE_AUX_SPOOL", () => {
		const said: string[] = [];
		const spool = createSpool(undefined, (l) => said.push(l));
		spool.gate("goal", "passed", 1);
		spool.gate("goal", "passed", 1);
		expect(said.length).toBeLessThanOrEqual(1);
	});
});

describe("Claude transcript → pi entries", () => {
	const lines = [
		{ type: "user", uuid: "u1", message: { role: "user", content: "fix the bug" } },
		{ type: "assistant", uuid: "a1", message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } },
		{ type: "assistant", uuid: "a2", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" } },
		{ type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.ts" }] }] } },
		{ type: "user", uuid: "meta", isMeta: true, message: { role: "user", content: "<command-name>/clear</command-name>" } },
		{ type: "assistant", uuid: "side", isSidechain: true, message: { id: "s", role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } },
		{ type: "assistant", uuid: "a3", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Fixed in a.ts." }], stop_reason: "end_turn" } },
		{ type: "system", uuid: "sys" },
	];

	it("merges an assistant message's per-block lines, maps tool results and stop reasons, drops meta and sidechains", () => {
		const entries = toPiEntries(lines);
		expect(entries.map((e) => e.message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(entries[1]).toMatchObject({ id: "a1", message: { stopReason: "toolUse", content: [{ type: "thinking" }, { type: "toolCall", id: "t1", name: "Bash" }] } });
		expect(entries[2].message).toMatchObject({ role: "toolResult", toolCallId: "t1", toolName: "Bash", content: [{ type: "text", text: "a.ts" }] });
		expect(entries[3].message).toMatchObject({ stopReason: "stop" });
		// pi's own folds read it unchanged.
		expect(recapTranscript(entries)).toBe(
			'[user] fix the bug\n\n[toolCall Bash] {"command":"ls"}\n\n[toolResult Bash] a.ts\n\n[assistant] Fixed in a.ts.',
		);
		expect(classifyHandback(entries).kind).toBe("none");
	});

	it("appends the hook's final assistant text only when the transcript lags", () => {
		const entries = toPiEntries(lines);
		expect(withFinalAssistant(entries, "Fixed in a.ts.")).toHaveLength(entries.length);
		const lagging = withFinalAssistant(entries, "And pushed the branch.");
		expect(lagging).toHaveLength(entries.length + 1);
		expect(lagging.at(-1)?.message).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("reads only COMPLETE appended lines from a byte cursor", () => {
		const path = join(tmp(), "t.jsonl");
		writeFileSync(path, `${JSON.stringify(lines[0])}\n`);
		const first = readAppendedLines(path, 0);
		expect(first.lines).toHaveLength(1);
		appendFileSync(path, `${JSON.stringify(lines[6])}\n{"type":"assist`);
		const second = readAppendedLines(path, first.next);
		expect(second.lines).toHaveLength(1);
		expect(readAppendedLines(path, second.next).lines).toHaveLength(0);
		expect(() => readAppendedLines(path, 0)).not.toThrow();
	});

	it("reads Claude's synthetic API-error turn as a turn that did not run", () => {
		const entries = toPiEntries([
			{ type: "user", uuid: "u", message: { role: "user", content: "go" } },
			{ type: "assistant", uuid: "e", isApiErrorMessage: true, message: { id: "x", role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "You've hit your session limit" }] } },
		]);
		expect(entries[1].message).toMatchObject({ role: "assistant", stopReason: "error" });
		expect(turnFailureOf(entries)).toBe("error");
	});

	it("throws on a malformed line rather than reading it as empty", () => {
		const path = join(tmp(), "bad.jsonl");
		writeFileSync(path, "{nope}\n");
		expect(() => readAppendedLines(path, 0)).toThrow(/line 1 is not JSON/);
	});
});

describe("cheap lane on a leased store", () => {
	const modes = [
		{ key: "high", model: "openai-codex/top" },
		{ key: "mid", model: "zai/mid" },
		{ key: "low", model: "xai/low" },
	];
	it("takes `low` when its provider is leased", () => {
		expect(cheapLaneMode(modes, isConfiguredWith(new Set(["xai", "zai"])))?.model).toBe("xai/low");
	});
	it("otherwise the cheapest leased mode, and nothing when none is leased", () => {
		expect(cheapLaneMode(modes, isConfiguredWith(new Set(["zai"])))?.model).toBe("zai/mid");
		expect(cheapLaneMode(modes, isConfiguredWith(new Set(["anthropic"])))).toBeUndefined();
	});
});

describe("process-group kill for a Claude helper's children", () => {
	it("spawns detached only for a Claude helper", () => {
		expect(treeSpawnOptions({ HIVE_PI_AGENT_DIR: "/lease" })).toEqual({ detached: true });
		expect(treeSpawnOptions({})).toEqual({ detached: false });
	});

	it("kills the grandchild too", async () => {
		const marker = join(tmp(), "grandchild.pid");
		const tree = treeSpawnOptions({ HIVE_PI_AGENT_DIR: "/lease" });
		const child = spawn("bash", ["-c", `sleep 30 & echo $! > ${marker}; wait`], { stdio: "ignore", ...tree });
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			try {
				if (readFileSync(marker, "utf8").trim()) break;
			} catch {
				/* not written yet */
			}
			await new Promise((r) => setTimeout(r, 20));
		}
		const grandchild = Number.parseInt(readFileSync(marker, "utf8"), 10);
		const closed = new Promise((done) => child.on("close", done));
		killTree(child, "SIGKILL", tree.detached);
		await closed;
		await new Promise((r) => setTimeout(r, 100));
		expect(() => process.kill(grandchild, 0)).toThrow();
	});
});

describe("the repo gate under a host's wall clock", () => {
	it("reports a check the CAP cut short as a skip — no injection, no charge, no failure stamp", async () => {
		const repo = join(tmp(), "repo");
		mkdirSync(join(repo, ".pi"), { recursive: true });
		execFileSync("git", ["init", "-q", repo]);
		writeFileSync(join(repo, ".pi", "harness.json"), JSON.stringify({ check: "sleep 5", checkTimeoutMs: 600000 }));
		const stamps = new Map<string, string>();
		const policy = createGatePolicy(
			{ get: (id) => stamps.get(id), set: (id, stamp) => (stamp === undefined ? stamps.delete(id) : stamps.set(id, stamp)) },
			{ timeoutCapMs: () => 200 },
		);
		const work = policy.decide({ cwd: repo, ledger: emptyLedger, lastAssistantText: undefined, transcript: "" });
		const outcome = await work?.run();
		expect(outcome).toEqual({ metric: { outcome: "skip", value: expect.any(Number) } });
		expect(stamps.size).toBe(0);
	});

	it("still reports the repo's OWN timeout as a timeout", async () => {
		const repo = join(tmp(), "repo2");
		mkdirSync(join(repo, ".pi"), { recursive: true });
		execFileSync("git", ["init", "-q", repo]);
		writeFileSync(join(repo, ".pi", "harness.json"), JSON.stringify({ check: "sleep 5", checkTimeoutMs: 200 }));
		const policy = createGatePolicy(undefined, { timeoutCapMs: () => 60_000 });
		const outcome = await policy.decide({ cwd: repo, ledger: emptyLedger, lastAssistantText: undefined, transcript: "" })?.run();
		expect(outcome?.metric.outcome).toBe("timeout");
		expect(outcome?.inject).toContain("TIMED OUT");
	});
});

describe("getPiInvocation with a JavaScript pi override", () => {
	it("runs a .js entry under this node, and anything else directly", () => {
		const previous = process.env.PI_HOUSE_PI_BIN;
		try {
			process.env.PI_HOUSE_PI_BIN = "/opt/pi/dist/bundle/cli.js";
			expect(getPiInvocation(["-p"])).toEqual({ command: process.execPath, args: ["/opt/pi/dist/bundle/cli.js", "-p"] });
			process.env.PI_HOUSE_PI_BIN = "/opt/pi/bin/pi";
			expect(getPiInvocation(["-p"])).toEqual({ command: "/opt/pi/bin/pi", args: ["-p"] });
		} finally {
			if (previous === undefined) delete process.env.PI_HOUSE_PI_BIN;
			else process.env.PI_HOUSE_PI_BIN = previous;
		}
	});
});

describe("tryLock", () => {
	it("is exclusive while the holder lives, and takes over a dead holder's lock", () => {
		const path = join(tmp(), "x.lock");
		const release = tryLock(path);
		expect(release).not.toBeNull();
		expect(tryLock(path)).toBeNull(); // this very process holds it
		release?.();
		expect(existsSync(path)).toBe(false);
		writeFileSync(path, "999999999"); // no such pid
		const taken = tryLock(path);
		expect(taken).not.toBeNull();
		expect(readFileSync(path, "utf8")).toBe(String(process.pid));
		taken?.();
	});
});
