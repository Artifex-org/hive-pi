import { describe, expect, it } from "vitest";
import { createdPullURL } from "../extensions/hive-common/pull-delivery.ts";
import { createPullReporter } from "../extensions/hive-remote/pull-delivery.ts";
import type { RequestResult } from "../extensions/hive-common/http.ts";

const URL = "https://github.com/Artifex-org/hive-pi/pull/138";
const accepted: RequestResult = { ok: true, status: 201, authFailed: false, permanent: false, retryAfterMs: null };
const rejected: RequestResult = { ...accepted, ok: false, status: 404, permanent: true, error: "pull request project not found" };

describe("created PR delivery", () => {
	it("requires a create command, not an arbitrary URL from a view or log", () => {
		expect(createdPullURL("git push && gh pr create --draft", URL)).toBe(URL);
		for (const command of ["gh pr view 138", "echo link", "gh issue create"])
			expect(createdPullURL(command, URL)).toBeNull();
	});

	it("deduplicates in-flight and delivered URLs across completion executions", async () => {
		let resolve!: (result: RequestResult) => void;
		let submissions = 0;
		const reporter = createPullReporter({
			binding: () => ({ key: "session-a:1", submit: () => { submissions++; return new Promise(done => { resolve = done; }); } }),
			notice: () => { throw new Error("unexpected rejection"); },
		});
		const first = reporter.report(URL, "execution-1");
		await reporter.report(URL, "execution-1");
		await reporter.report(URL, "execution-2");
		resolve(accepted); await first;
		await reporter.report(URL, "execution-3");
		expect(submissions).toBe(1);
	});

	it("does not announce a stale rejection in the replacement session", async () => {
		let key = "session-a:1", resolve!: (result: RequestResult) => void;
		const notices: string[] = [];
		const reporter = createPullReporter({
			binding: () => ({ key, submit: () => key === "session-a:1" ? new Promise(done => { resolve = done; }) : Promise.resolve(accepted) }),
			notice: text => notices.push(text),
		});
		const old = reporter.report(URL, "execution-1");
		key = "session-b:2"; reporter.clear();
		await reporter.report(URL, "execution-1");
		resolve(rejected); await old;
		expect(notices).toEqual([]);
	});

	it("bounds a thrown submission failure and allows a fresh execution", async () => {
		let submissions = 0;
		const notices: string[] = [];
		const reporter = createPullReporter({
			binding: () => ({ key: "session:1", submit: async () => {
				if (++submissions === 1) throw new Error("private network details must not be echoed");
				return accepted;
			} }), notice: text => notices.push(text),
		});
		await reporter.report(URL, "execution-1");
		await reporter.report(URL, "execution-2");
		expect(submissions).toBe(2);
		expect(notices).toEqual([expect.stringContaining("HTTP unavailable")]);
		expect(notices[0]).not.toContain("private network details");
	});

	it("preserves failure and permits a new execution to retry after it", async () => {
		let submissions = 0;
		const notices: string[] = [];
		const reporter = createPullReporter({
			binding: () => ({ key: "session:1", submit: async () => ++submissions === 1 ? rejected : accepted }),
			notice: text => notices.push(text),
		});
		await reporter.report(URL, "execution-1");
		await reporter.report(URL, "execution-1");
		await reporter.report(URL, "execution-2");
		expect(submissions).toBe(2);
		expect(notices).toEqual([expect.stringContaining("HTTP 404")]);
	});
});
