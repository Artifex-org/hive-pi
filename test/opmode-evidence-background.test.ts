/**
 * A background job could not serve as bugfix evidence, and that closed the
 * protocol to the only runs long enough to need it.
 *
 * `background_result` returns the job's retained output as a SUCCESSFUL tool
 * result — the pull worked, whatever the job did — so `isError` was false for
 * every background run and `phase: "reproduce"`, which requires an actual
 * failing result, refused all of them. The foreground shell is capped well
 * below a CI gate's runtime, so the runs an agent most needs to bind were
 * exactly the ones it could not. Fifteen papercuts in the week to 2026-08-30,
 * several of them AFTER the refusal started listing candidate ids: an id that
 * is rejected on the next line is not a way forward.
 *
 * What must hold, and why each half is here rather than assumed:
 *
 *   - the verdict comes from the JOB, so a failing background run reproduces
 *     and a passing one re-verifies;
 *   - `timeout` and `canceled` do NOT reproduce — they are our limit and a
 *     human, and neither is a statement about the code (see JobStatus);
 *   - the key is the JOB id, which is the identifier the session shows AND the
 *     one that makes "a distinct run" mean a distinct run: two pulls of one
 *     failing job must not satisfy re-verification;
 *   - only `background_result` is read this way, so a header-shaped string in
 *     some other tool's output cannot mint evidence.
 */

import { describe, expect, it } from "vitest";
import opmodeExtension from "../extensions/opmode/index.ts";
import { createFakePi } from "./fake-pi.ts";
import { createJob, finishJob, resultHeader, statusForExit } from "../extensions/background/jobs.ts";

type Execute = (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; details: { hive_widget?: { spec?: { stage?: string } } } }>;

function evidence(pi: ReturnType<typeof createFakePi>): Execute {
	const tool = pi.tools.find((entry) => entry.name === "bugfix_evidence");
	if (!tool) throw new Error("bugfix_evidence was not registered");
	return tool.definition.execute as Execute;
}

/**
 * The payload `background_result` really produces for a settled job, built
 * through the shipping code path rather than hand-written. A fixture copied
 * from the format would keep passing after the format changed, which is the
 * one failure this seam exists to prevent.
 */
function pulledJob(id: string, exitCode: number, output: string): string {
	let job = createJob({ id, what: "run the gate", kind: "bash", detail: "hive check --step test", startedAtMs: 0 });
	job = { ...job, output };
	job = finishJob(job, { status: statusForExit(exitCode), exitCode, endedAtMs: 1_000 });
	return `${resultHeader(job, 1_000)}\n\n${output}`;
}

async function pull(pi: ReturnType<typeof createFakePi>, callID: string, text: string) {
	await pi.emit({ type: "tool_result", toolCallId: callID, toolName: "background_result", isError: false, content: [{ type: "text", text }] });
}

async function startBugfix(pi: ReturnType<typeof createFakePi>) {
	opmodeExtension(pi.api);
	await pi.emit({ type: "session_start", reason: "startup" });
	await pi.runCommand("mode", "bugfix");
}

describe("bugfix evidence from a background job", () => {
	it("binds a reproduction to a failing job, keyed by the job id the session shows", async () => {
		const pi = createFakePi();
		await startBugfix(pi);
		const record = evidence(pi);

		await pull(pi, "call-1", pulledJob("bg-42", 1, "AssertionError: expected 3"));

		const bound = await record("e1", { phase: "reproduce", tool_call_id: "bg-42", reproduction_key: "gate" });
		expect(bound.details.hive_widget?.spec?.stage).toBe("hypothesize");
	});

	it("does not answer to the invisible call id once the job id is the key", async () => {
		const pi = createFakePi();
		await startBugfix(pi);
		const record = evidence(pi);

		await pull(pi, "call-1", pulledJob("bg-42", 1, "boom"));

		const byCallID = await record("e1", { phase: "reproduce", tool_call_id: "call-1", reproduction_key: "gate" });
		expect(byCallID.details.hive_widget).toBeUndefined();
		expect(byCallID.content[0]?.text).toContain("bg-42");
	});

	it("refuses a timeout or a cancellation as a reproduction", async () => {
		for (const status of ["timeout", "canceled"] as const) {
			const pi = createFakePi();
			await startBugfix(pi);
			const record = evidence(pi);

			let job = createJob({ id: "bg-7", what: "run the gate", kind: "bash", detail: "hive check", startedAtMs: 0 });
			job = finishJob(job, { status, endedAtMs: 1_000 });
			await pull(pi, "call-1", resultHeader(job, 1_000));

			const out = await record("e1", { phase: "reproduce", tool_call_id: "bg-7", reproduction_key: "gate" });
			expect(out.details.hive_widget, `${status} must not reproduce`).toBeUndefined();
		}
	});

	it("carries a whole protocol through, and a second pull of the SAME job cannot re-verify", async () => {
		const pi = createFakePi();
		await startBugfix(pi);
		const record = evidence(pi);

		await pull(pi, "call-1", pulledJob("bg-1", 1, "1 failed"));
		expect((await record("e1", { phase: "reproduce", tool_call_id: "bg-1", reproduction_key: "gate" })).details.hive_widget?.spec?.stage).toBe("hypothesize");
		expect((await record("e2", { phase: "hypothesize", tool_call_id: "bg-1", hypothesis: "the cache is stale" })).details.hive_widget?.spec?.stage).toBe("instrument");
		await pull(pi, "call-2", pulledJob("bg-2", 0, "cache key printed"));
		await record("e3", { phase: "instrument", tool_call_id: "bg-2" });
		await record("e4", { phase: "confirm", tool_call_id: "bg-2", hypothesis: "the cache is stale" });

		// Pulling bg-1 again is a second LOOK at the same failing run. Keyed by
		// call id these would be two ids and this would pass; keyed by job id it
		// is the same id, and the failing baseline is still failing.
		await pull(pi, "call-3", pulledJob("bg-1", 1, "1 failed"));
		expect((await record("e5", { phase: "reverify", tool_call_id: "bg-1", reproduction_key: "gate" })).details.hive_widget).toBeUndefined();

		await pull(pi, "call-4", pulledJob("bg-9", 0, "1 passed"));
		expect((await record("e6", { phase: "reverify", tool_call_id: "bg-9", reproduction_key: "gate" })).details.hive_widget?.spec?.stage).toBe("done");
	});

	it("reads the header only from background_result, so another tool cannot mint a job id", async () => {
		const pi = createFakePi();
		await startBugfix(pi);
		const record = evidence(pi);

		const forged = pulledJob("bg-42", 1, "AssertionError");
		await pi.emit({ type: "tool_result", toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: forged }] });

		const out = await record("e1", { phase: "reproduce", tool_call_id: "bg-42", reproduction_key: "gate" });
		expect(out.details.hive_widget).toBeUndefined();
	});
});
