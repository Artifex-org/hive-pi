/**
 * The Claude adapter's small pieces: the spool's record contract, the Claude
 * transcript translation, the leased-provider model choice, and the
 * process-group kill pi children get in a Claude launch.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { recapTranscript } from "../extensions/agenda/recap.ts";
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
		expect(recapTranscript(entries)).toBe("[user] fix the bug\n\n[toolResult] a.ts\n\n[assistant] Fixed in a.ts.");
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
