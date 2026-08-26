/**
 * The background job fold.
 *
 * These are the rules that decide what the model is told and what it costs to
 * tell it. The extension's behaviour (spawning, reaping, delivery) is tested
 * separately in `background-extension.test.ts` against the fake pi.
 */

import { describe, expect, it } from "vitest";

import {
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	NOTIFY_TAIL_BYTES,
	appendOutput,
	createJob,
	finishJob,
	footerSegment,
	formatDuration,
	nextJobId,
	notificationFor,
	outputTail,
	pendingNotifications,
	renderList,
	resolveTimeoutMs,
	statusForExit,
	type Job,
} from "../extensions/background/jobs.ts";

function job(overrides: Partial<Job> = {}): Job {
	return {
		...createJob({ id: "bg-1", what: "running the tests", kind: "bash", detail: "npm test", startedAtMs: 1_000 }),
		...overrides,
	};
}

describe("output retention", () => {
	it("keeps the TAIL when capping, because that is where failures print", () => {
		const capped = appendOutput(job(), "abcdefghij", 4);
		expect(capped.output).toBe("ghij");
		expect(capped.droppedBytes).toBe(6);
	});

	it("counts dropped bytes across multiple appends rather than resetting", () => {
		let current = appendOutput(job(), "aaaaaa", 4);
		current = appendOutput(current, "bbbbbb", 4);
		expect(current.output).toBe("bbbb");
		expect(current.droppedBytes).toBe(8);
	});

	it("leaves output untouched below the cap", () => {
		const small = appendOutput(job(), "hello", 100);
		expect(small.output).toBe("hello");
		expect(small.droppedBytes).toBe(0);
	});

	it("ignores an empty chunk without allocating a new record", () => {
		const original = job();
		expect(appendOutput(original, "")).toBe(original);
	});
});

describe("terminal transitions", () => {
	it("refuses to overwrite a terminal state — a kill's exit code must not bury the cancel", () => {
		// The real sequence: a human cancels, we SIGTERM, and the process then
		// emits `close` with 143. Without this rule the record would read
		// "failed (exit 143)" for something the human deliberately stopped.
		const canceled = finishJob(job(), { status: "canceled", endedAtMs: 2_000 });
		const afterKill = finishJob(canceled, { status: "failed", exitCode: 143, endedAtMs: 2_100 });
		expect(afterKill.status).toBe("canceled");
		expect(afterKill.exitCode).toBeUndefined();
	});

	it("treats only zero as success", () => {
		expect(statusForExit(0)).toBe("done");
		expect(statusForExit(1)).toBe("failed");
		expect(statusForExit(null)).toBe("failed");
	});
});

describe("the completion notification", () => {
	it("caps what it volunteers, and says where the rest is", () => {
		const noisy = finishJob(
			appendOutput(job(), "x".repeat(50_000)),
			{ status: "done", exitCode: 0, endedAtMs: 5_000 },
		);
		const text = notificationFor(noisy, 5_000);

		// The cap is the whole point: this text enters context unconditionally.
		expect(text.length).toBeLessThan(NOTIFY_TAIL_BYTES * 2);
		expect(text).toContain("background_result");
		expect(text).toContain("bg-1");
	});

	it("does not claim truncation when the whole output fits", () => {
		const small = finishJob(appendOutput(job(), "all done\n"), {
			status: "done",
			exitCode: 0,
			endedAtMs: 3_000,
		});
		const text = notificationFor(small, 3_000);
		expect(text).toContain("all done");
		expect(text).not.toContain("Truncated");
		expect(text).toContain("Output:");
	});

	it("distinguishes a cancel and a timeout from a real failure", () => {
		// These three must not read alike: a failure is about the code, while a
		// timeout and a cancel say nothing about it at all. Collapsing them sends
		// the model debugging a phantom.
		const failed = finishJob(job(), { status: "failed", exitCode: 2, endedAtMs: 2_000 });
		const timedOut = finishJob(job(), { status: "timeout", endedAtMs: 2_000 });
		const canceled = finishJob(job(), { status: "canceled", endedAtMs: 2_000 });

		expect(notificationFor(failed, 2_000)).toContain("exit 2");
		expect(notificationFor(timedOut, 2_000)).toContain("time limit");
		expect(notificationFor(canceled, 2_000)).toContain("canceled");
	});

	it("names the job, so a second notification cannot be mistaken for this one", () => {
		const first = finishJob(job({ id: "bg-1", what: "the build" }), { status: "done", endedAtMs: 2_000 });
		const second = finishJob(job({ id: "bg-2", what: "the tests" }), { status: "done", endedAtMs: 2_000 });
		expect(notificationFor(first, 2_000)).toContain("the build");
		expect(notificationFor(second, 2_000)).toContain("the tests");
	});

	it("says it produced no output rather than showing an empty block", () => {
		const silent = finishJob(job(), { status: "done", exitCode: 0, endedAtMs: 2_000 });
		expect(notificationFor(silent, 2_000)).toContain("no output");
	});

	it("adds the 'finish what you are doing' framing only when something needs deciding", () => {
		const ok = finishJob(job(), { status: "done", exitCode: 0, endedAtMs: 2_000 });
		const bad = finishJob(job(), { status: "failed", exitCode: 1, endedAtMs: 2_000 });
		expect(notificationFor(ok, 2_000)).not.toContain("finish the current thought");
		expect(notificationFor(bad, 2_000)).toContain("finish the current thought");
	});
});

describe("outputTail", () => {
	it("marks the elision so a truncated stack trace is not read as the whole one", () => {
		const long = appendOutput(job(), "y".repeat(500));
		expect(outputTail(long, 100).startsWith("…")).toBe(true);
	});
});

describe("the footer segment", () => {
	it("is nothing at all when no job is running", () => {
		expect(footerSegment([])).toBeNull();
		expect(footerSegment([finishJob(job(), { status: "done", endedAtMs: 2 })])).toBeNull();
	});

	it("counts only running jobs", () => {
		const running = job({ id: "bg-2" });
		const done = finishJob(job(), { status: "done", endedAtMs: 2 });
		expect(footerSegment([running, done])).toBe("1 bg job");
		expect(footerSegment([running, job({ id: "bg-3" })])).toBe("2 bg jobs");
	});
});

describe("pendingNotifications", () => {
	it("excludes running jobs and already-announced ones", () => {
		const running = job({ id: "bg-1" });
		const fresh = finishJob(job({ id: "bg-2" }), { status: "done", endedAtMs: 2 });
		const announced = { ...finishJob(job({ id: "bg-3" }), { status: "done", endedAtMs: 2 }), notified: true };
		expect(pendingNotifications([running, fresh, announced]).map((entry) => entry.id)).toEqual(["bg-2"]);
	});
});

describe("job ids", () => {
	it("are short and monotonic, not UUIDs — the model has to type them back", () => {
		expect(nextJobId([])).toBe("bg-1");
		expect(nextJobId([job({ id: "bg-1" }), job({ id: "bg-2" })])).toBe("bg-3");
	});

	it("does not reuse an id after earlier jobs finished", () => {
		// Reuse would make `background_result bg-2` ambiguous within one session.
		const finished = finishJob(job({ id: "bg-2" }), { status: "done", endedAtMs: 2 });
		expect(nextJobId([finished])).toBe("bg-3");
	});
});

describe("timeouts", () => {
	it("defaults when unset and clamps an absurd request", () => {
		expect(resolveTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
		expect(resolveTimeoutMs(0)).toBe(DEFAULT_TIMEOUT_MS);
		expect(resolveTimeoutMs(-5)).toBe(DEFAULT_TIMEOUT_MS);
		expect(resolveTimeoutMs(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS);
		expect(resolveTimeoutMs(999_999)).toBe(MAX_TIMEOUT_MS);
		expect(resolveTimeoutMs(60)).toBe(60_000);
	});
});

describe("formatDuration", () => {
	it("reads as a human would say it", () => {
		expect(formatDuration(450)).toBe("450ms");
		expect(formatDuration(4_000)).toBe("4s");
		expect(formatDuration(65_000)).toBe("1m 5s");
		expect(formatDuration(120_000)).toBe("2m");
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(5_400_000)).toBe("1h 30m");
	});
});

describe("renderList", () => {
	it("says so plainly when there is nothing", () => {
		expect(renderList([], 0)).toBe("No background jobs.");
	});

	it("shows the human description, not just the command", () => {
		const line = renderList([job({ what: "running the full test suite" })], 5_000);
		expect(line).toContain("running the full test suite");
		expect(line).toContain("bg-1");
	});
});
