/**
 * Where bugfix evidence may come from (papercuts 2026-09-29..10-04).
 *
 *   a) The SAME reproduction run through a different scheduling wrapper is the
 *      same evidence. A baseline from `bash` and a re-verification pulled from
 *      `background_result` (or the reverse) were refused: "result came from
 *      background_result, not bash — rerun the tool that reproduced it".
 *   b) A read of a run that ALREADY FAILED is a reproduction. `hive_get_task_logs`
 *      on a failed CI attempt was refused because the log read itself succeeded:
 *      "completed without failing, so it is not a reproduction". The rule is a
 *      reviewed list of tools whose result IS a verdict about another run, read
 *      from that result's structured state — not text sniffing, so an ordinary
 *      read that merely mentions FAILED still binds nothing.
 *   c) The ids the tool demands were never shown. In bugfix mode every result
 *      now carries its evidence id, and a background job that was announced
 *      by its completion message (never pulled) is bindable by its job id.
 */

import { describe, expect, it } from "vitest";
import opmodeExtension from "../extensions/opmode/index.ts";
import { createJob, finishJob, resultHeader, statusForExit } from "../extensions/background/jobs.ts";
import { createFakePi } from "./fake-pi.ts";

type Result = { content: Array<{ text: string }>; details: { hive_widget?: { spec?: { stage?: string } } } };
type Execute = (id: string, params: unknown) => Promise<Result>;

function evidence(pi: ReturnType<typeof createFakePi>): Execute {
	const tool = pi.tools.find((entry) => entry.name === "bugfix_evidence");
	if (!tool) throw new Error("bugfix_evidence was not registered");
	return tool.definition.execute as Execute;
}

async function startBugfix() {
	const pi = createFakePi();
	opmodeExtension(pi.api);
	await pi.emit({ type: "session_start", reason: "startup" });
	await pi.runCommand("mode", "bugfix");
	return pi;
}

function pulledJob(id: string, exitCode: number, output: string): string {
	let job = createJob({ id, what: "run the tests", kind: "bash", detail: "pytest -q", startedAtMs: 0 });
	job = { ...job, output };
	job = finishJob(job, { status: statusForExit(exitCode), exitCode, endedAtMs: 1_000 });
	return `${resultHeader(job, 1_000)}\n\n${output}`;
}

async function result(pi: ReturnType<typeof createFakePi>, toolCallId: string, toolName: string, text: string, isError = false) {
	return pi.emit({ type: "tool_result", toolCallId, toolName, isError, content: [{ type: "text", text }] });
}

/** Walk reproduce → confirm on `baseline`, leaving the machine at `fix`. */
async function throughConfirm(record: Execute, baseline: string, instrument: string) {
	expect((await record("e1", { phase: "reproduce", tool_call_id: baseline, reproduction_key: "k" })).details.hive_widget?.spec?.stage).toBe("hypothesize");
	await record("e2", { phase: "hypothesize", tool_call_id: baseline, hypothesis: "h" });
	await record("e3", { phase: "instrument", tool_call_id: instrument });
	expect((await record("e4", { phase: "confirm", tool_call_id: instrument, hypothesis: "h" })).details.hive_widget?.spec?.stage).toBe("fix");
}

const stage = (r: Result) => r.details.hive_widget?.spec?.stage;

describe("a) one reproduction, any shell wrapper", () => {
	it("re-verifies a bash baseline with a passing background job", async () => {
		const pi = await startBugfix();
		const record = evidence(pi);
		await result(pi, "call-1", "bash", "1 failed", true);
		await result(pi, "call-2", "bash", "instrumented");
		await throughConfirm(record, "call-1", "call-2");
		await result(pi, "call-3", "background_result", pulledJob("bg-4", 0, "1 passed"));
		expect(stage(await record("e5", { phase: "reverify", tool_call_id: "bg-4", reproduction_key: "k" }))).toBe("done");
	});

	it("re-verifies a background baseline with a passing foreground bash run", async () => {
		const pi = await startBugfix();
		const record = evidence(pi);
		await result(pi, "call-1", "background_result", pulledJob("bg-1", 1, "1 failed"));
		await result(pi, "call-2", "bash", "instrumented");
		await throughConfirm(record, "bg-1", "call-2");
		await result(pi, "call-3", "bash", "1 passed");
		expect(stage(await record("e5", { phase: "reverify", tool_call_id: "call-3", reproduction_key: "k" }))).toBe("done");
	});

	it("still refuses a re-verification from an unrelated tool", async () => {
		const pi = await startBugfix();
		const record = evidence(pi);
		await result(pi, "call-1", "bash", "1 failed", true);
		await result(pi, "call-2", "bash", "instrumented");
		await throughConfirm(record, "call-1", "call-2");
		await result(pi, "call-3", "read", "def f(): ...");
		const out = await record("e5", { phase: "reverify", tool_call_id: "call-3", reproduction_key: "k" });
		expect(stage(out)).toBeUndefined();
		expect(out.content[0]?.text).toMatch(/came from read/);
	});

	it("does not let a timed-out or cancelled job stand in as a passing re-verification", async () => {
		for (const status of ["timeout", "canceled"] as const) {
			const pi = await startBugfix();
			const record = evidence(pi);
			await result(pi, "call-1", "bash", "1 failed", true);
			await result(pi, "call-2", "bash", "instrumented");
			await throughConfirm(record, "call-1", "call-2");
			let job = createJob({ id: "bg-7", what: "w", kind: "bash", detail: "pytest", startedAtMs: 0 });
			job = finishJob(job, { status, endedAtMs: 1_000 });
			await result(pi, "call-3", "background_result", resultHeader(job, 1_000));
			const out = await record("e5", { phase: "reverify", tool_call_id: "bg-7", reproduction_key: "k" });
			expect(stage(out), status).toBeUndefined();
		}
	});
});

describe("b) a read of a run that already failed", () => {
	const taskLogs = (state: string) =>
		JSON.stringify({ task_id: "t-1", attempt: 1, attempt_state: state, log: "FAILED tests/test_x.py::test_a\nFAILED tests/test_x.py::test_b" }, null, 2);

	for (const name of ["hive_get_task_logs", "mcp__hive__get_task_logs"]) {
		it(`binds a failed CI attempt read through ${name}`, async () => {
			const pi = await startBugfix();
			const record = evidence(pi);
			await result(pi, "call-1", name, taskLogs("failed"));
			expect(stage(await record("e1", { phase: "reproduce", tool_call_id: "call-1", reproduction_key: "k" }))).toBe("hypothesize");
		});
	}

	it("reads the run's own state from explain_failure even past a long failures list", async () => {
		const pi = await startBugfix();
		const record = evidence(pi);
		// Go marshals map keys sorted, so `failures` (with log tails) precedes
		// `run` — the verdict sits far past any preview-length cut.
		const body = JSON.stringify(
			{ failures: [{ task: "test", log_tail: "x".repeat(5_000) }], run: { id: "r", state: "failed" }, summary: "1 failed" },
			null,
			2,
		);
		await result(pi, "call-1", "hive_explain_failure", body);
		expect(stage(await record("e1", { phase: "reproduce", tool_call_id: "call-1", reproduction_key: "k" }))).toBe("hypothesize");
	});

	it("re-verifies with the green rerun's run record", async () => {
		const pi = await startBugfix();
		const record = evidence(pi);
		await result(pi, "call-1", "hive_get_task_logs", taskLogs("failed"));
		await result(pi, "call-2", "bash", "instrumented");
		await throughConfirm(record, "call-1", "call-2");
		await result(pi, "call-3", "mcp__hive__get_run", JSON.stringify({ run: { id: "r2", state: "succeeded" }, tasks: [] }));
		expect(stage(await record("e5", { phase: "reverify", tool_call_id: "call-3", reproduction_key: "k" }))).toBe("done");
	});

	it("reads the tool's own JSON even when another extension appended a note after it", async () => {
		// narrate, guards-bridge and pr-attachments all append to tool results,
		// and pi chains handlers in load order — they run before opmode.
		const pi = await startBugfix();
		const record = evidence(pi);
		await pi.emit({
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "hive_get_task_logs",
			isError: false,
			content: [{ type: "text", text: taskLogs("failed") }, { type: "text", text: "[reminder] narrate your next step" }],
		});
		expect(stage(await record("e1", { phase: "reproduce", tool_call_id: "call-1", reproduction_key: "k" }))).toBe("hypothesize");

		// toolhints/guards append INTO the last text part rather than adding one.
		await result(pi, "call-2", "hive_get_task_logs", `${taskLogs("failed")}\n\n[hint] the task id is also accepted as a run number`);
		const pulled = await record("e2", { phase: "reproduce", tool_call_id: "call-2", reproduction_key: "k" });
		expect(pulled.content[0]?.text).not.toMatch(/completed without failing|no verdict/);
	});

	it("does not treat a still-running run as either verdict", async () => {
		const pi = await startBugfix();
		const record = evidence(pi);
		await result(pi, "call-1", "hive_wait_for_run", JSON.stringify({ run: { state: "running" }, terminal: false }));
		expect(stage(await record("e1", { phase: "reproduce", tool_call_id: "call-1", reproduction_key: "k" }))).toBeUndefined();
	});

	it("refuses an ordinary successful read whose text merely says FAILED", async () => {
		const pi = await startBugfix();
		const record = evidence(pi);
		await result(pi, "call-1", "read", '{"attempt_state": "failed"}\nFAILED tests/test_x.py');
		await result(pi, "call-2", "hive_get_ticket", JSON.stringify({ state: "failed", title: "x" }));
		for (const id of ["call-1", "call-2"]) {
			const out = await record("e1", { phase: "reproduce", tool_call_id: id, reproduction_key: "k" });
			expect(stage(out), id).toBeUndefined();
			expect(out.content[0]?.text).toMatch(/completed without failing/);
		}
	});
});

describe("c) the ids the tool asks for are visible", () => {
	it("appends the evidence id to every tool result while bugfix mode is on", async () => {
		const pi = await startBugfix();
		const [out] = (await result(pi, "call_rUl", "bash", "1 failed", true)) as [{ content?: Array<{ text?: string }> } | undefined];
		const texts = (out?.content ?? []).map((c) => c.text ?? "");
		expect(texts[0]).toBe("1 failed");
		expect(texts.at(-1)).toContain("call_rUl");
	});

	it("names the job id, not the invisible call id, for a pulled job", async () => {
		const pi = await startBugfix();
		const [out] = (await result(pi, "call-9", "background_result", pulledJob("bg-30", 1, "boom"))) as [{ content?: Array<{ text?: string }> }];
		const tag = (out.content ?? []).at(-1)?.text ?? "";
		expect(tag).toContain("bg-30");
		expect(tag).not.toContain("call-9");
	});

	it("adds nothing outside bugfix mode", async () => {
		const pi = createFakePi();
		opmodeExtension(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		const [out] = await result(pi, "call-1", "bash", "ok");
		expect(out).toBeUndefined();
	});

	it("binds a background job announced by its completion message and never pulled", async () => {
		// Papercut: "lists recent result IDs but omits the completed bg-30 failing
		// Playwright run". A job whose notification carried its whole output was
		// never pulled through background_result, so the gate never saw it.
		const pi = await startBugfix();
		const record = evidence(pi);
		await pi.emit({
			type: "message_end",
			message: {
				role: "custom",
				customType: "background",
				content: "✗ background job `bg-30` (playwright) failed after 41s.",
				display: true,
				details: { id: "bg-30", status: "failed", exitCode: 1, what: "playwright" },
				timestamp: 0,
			},
		});
		expect(stage(await record("e1", { phase: "reproduce", tool_call_id: "bg-30", reproduction_key: "k" }))).toBe("hypothesize");
	});
});
