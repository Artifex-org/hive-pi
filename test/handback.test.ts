/**
 * The hand-back classifier (hive-common/handback.ts).
 *
 * The failure it prevents: an automatic turn lands on a turn that handed the
 * conversation to a person — a question, a plan up for approval, a pending
 * grant, "ich warte auf deine Freigabe" — and the model carries on with a
 * decision the human never made. It is silent and it looks like progress.
 *
 * Half of these cases are about NOT firing. A hand-back read into a report
 * stalls plan auto-continue on exactly the "Wave done." stop it exists for, and
 * holds a CI verdict the agent is waiting to hear. The positive fixtures are
 * real endings from the 2026-10-05 transcript measurement.
 */

import { describe, expect, it } from "vitest";
import { classifyHandback, classifyText, endsWithQuestion, handbackClass, isFirmHandback } from "../extensions/hive-common/handback.ts";
import { decideWake } from "../extensions/hive-common/waker.ts";

describe("endsWithQuestion — fires", () => {
	it.each([
		["a bare question", "Should I proceed?"],
		["trailing newlines", "Ready to deploy?\n\n"],
		["a trailing space", "Which one? "],
		["a closing paren after the mark", "Shall I continue? )"],
		["a markdown bold wrapper", "**Proceed?**"],
		["a blockquote marker", "> Do you want me to retry?"],
		["a question after prose", "I found three options. Which should I use?"],
	])("%s", (_label, text) => {
		expect(endsWithQuestion(text)).toBe(true);
	});
});

describe("endsWithQuestion — stays quiet", () => {
	it.each([
		["a statement", "I fixed the build."],
		["empty text", ""],
		["a question mid-paragraph, resolved after", "Should I retry? I retried, and it passed."],
		["a question mark inside a fenced block", "Done.\n\n```sh\ngrep -q 'x' && echo '?'\n```"],
		["a fenced block that IS the last thing", "Here is the command:\n\n```\ntest -f x || echo ?\n```"],
		["an unterminated fence", "Running:\n\n```sh\nfoo --bar ?"],
		["a question mark in inline code", "Use the `?` operator."],
		["a regex ending the message", "Matched with `/ab?c/`"],
		["a URL query string", "See https://example.com/x?y=1"],
	])("%s", (_label, text) => {
		expect(endsWithQuestion(text)).toBe(false);
	});
});

const user = (content: string) => ({ type: "message", message: { role: "user", content } });
const said = (text: string, stopReason = "stop") => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }], stopReason },
});
const called = (id: string, name: string, args: unknown = {}) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" },
});
const result = (id: string, toolName: string, text: string) => ({
	type: "message",
	message: { role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }] },
});
const notice = (customType: string) => ({ type: "custom_message", customType, content: "x" });

describe("classifyText — hands back to a person", () => {
	it.each([
		["German wait for approval", "Verstanden. Ich warte auf deine Freigabe, starte keine weiteren Versuche und ändere nichts."],
		["German, no further work without release", "Keine Fortsetzung ohne Joans angekündigte Freigabe. Modelländerung, Build und Registrierung sind weiterhin offen."],
		["awaiting the operator", "Frozen clean commit retained. No edits, retries, resources, push, or PR. Awaiting operator authorization for repair."],
		["blocked on the controller", "State: s1/s2/s3 done; s4 blocked on controller decision. Tree clean at `f6312a44`."],
		["waiting for a readiness signal", "Canceled E2E #72; no replacement run started. Waiting for your readiness signal."],
		["authorization required", "Sessions are stopped. Further progress requires explicit authorization for a separate tooling fix."],
		["prose decision request", "Two options: keep the boundary, or integrate the repair. Let me know which."],
		["plan approve pointer", "Plan is saved. The user approves with /plan approve."],
	])("%s", (_label, text) => {
		const handback = classifyText(text);
		expect(handback.kind).toBe("human");
		expect(isFirmHandback(handback)).toBe(true);
	});

	it.each([
		["standing by", "Standing by — all work delivered or blocked on others; nothing executable remains."],
		["holding", "Holding per STOP; nothing executable."],
		["stopping", "**Next step:** run `hive_explain_failure` for run11974.  Handoff saved. Stopping."],
	])("%s is a soft wait", (_label, text) => {
		const handback = classifyText(text);
		expect(handback).toMatchObject({ kind: "human", reason: "waiting" });
		expect(handbackClass(handback)).toBe("waiting");
	});
});

describe("classifyText — waiting on its own job", () => {
	it.each([
		["watcher will deliver", "No failures, nothing actionable — the watcher will deliver the verdict. Standing by; will inspect all tasks at the exact head the moment it completes."],
		["awaits a run", "Branch-behavior evidence delivered: 162 passed. Final harvest awaits run #1769 — standing by."],
		["still watching", "Sent the review packet; holding further pushes until it's cleared. Still watching run #1828."],
		["standing by for the verdict", "Diff narrowed to 9 files. Standing by for the verdict; will inspect all tasks on completion."],
	])("%s", (_label, text) => {
		expect(classifyText(text)).toEqual({ kind: "machine", reason: "own-work" });
	});
});

describe("classifyText — a plain stop stays plain", () => {
	it.each([
		["the low-tier wave summary auto-continue exists for", "Wave done."],
		["a report", "Confirmed: draft 16, model version 8 is registered. Nothing published."],
		["a completion", "Frontend tests, build, typecheck and lint passed; screenshots attached. Not deployed."],
		["confirm as a report", "I can confirm the tests pass on the final commit."],
		["holding as a verb mid-sentence", "The lock file is holding a stale pid; I removed it and the build passed."],
		["German report with Bestätigung", "Die Bestätigung kam um 10:02; der Build ist grün."],
		["a route that requires authorization", "Fixed: the /api/orders route now requires authorization."],
		["German report after the release", "Nach der Freigabe habe ich deployed; Build ist grün."],
		["a decision not to retry a flake", "Flaky test failed; I will not retry it, root cause fixed and suite passes."],
		["a status label", "Status: holding pattern resolved, queue drained."],
	])("%s", (_label, text) => {
		expect(classifyText(text)).toEqual({ kind: "none" });
	});
});

describe("classifyHandback — the branch decides", () => {
	it("a user message after the hand-back is the answer", () => {
		expect(classifyHandback([user("go"), said("Shall I merge?"), user("yes")])).toEqual({ kind: "none" });
	});

	it("an automatic notice after the hand-back does not answer it", () => {
		expect(classifyHandback([user("go"), said("Shall I merge?"), notice("background")]).kind).toBe("human");
	});

	it("a human abort holds", () => {
		expect(classifyHandback([user("go"), said("", "aborted")])).toMatchObject({ kind: "human", reason: "aborted", structured: true });
	});

	it("a provider error is not a hand-back", () => {
		expect(classifyHandback([user("go"), said("Shall I?", "error")])).toEqual({ kind: "none" });
	});

	it("a plan presented for approval holds, whatever the summary says", () => {
		const branch = [
			user("plan it"),
			called("c1", "plan_ready"),
			result("c1", "plan_ready", "Plan is ready and awaiting approval:\n\nFix it\n\nThe user approves with /plan approve."),
			said("Here is the plan. Three steps."),
		];
		expect(classifyHandback(branch)).toMatchObject({ kind: "human", reason: "plan-approval", structured: true });
	});

	it("the 30-minute plan_ready timeout still holds", () => {
		const branch = [
			user("plan it"),
			called("c1", "plan_ready"),
			result("c1", "plan_ready", "Plan is ready and awaiting approval:\n\nX\n\nNo decision yet after 30 minutes. The plan stays ready."),
			said("Still waiting."),
		];
		expect(classifyHandback(branch)).toMatchObject({ reason: "plan-approval" });
	});

	it("an approved plan does not hold", () => {
		const branch = [
			user("plan it"),
			called("c1", "plan_ready"),
			result("c1", "plan_ready", "Plan is ready and awaiting approval:\n\nX\n\nApproved. Plan mode is released — execute it."),
			said("Step 1 done."),
		];
		expect(classifyHandback(branch)).toEqual({ kind: "none" });
	});

	it("a plan from an EARLIER run does not hold the current stop", () => {
		const branch = [
			user("plan it"),
			called("c1", "plan_ready"),
			result("c1", "plan_ready", "Plan is ready and awaiting approval:\n\nX"),
			said("Plan presented."),
			notice("agenda"),
			called("c2", "bash"),
			result("c2", "bash", "ok"),
			said("Wave done."),
		];
		expect(classifyHandback(branch)).toEqual({ kind: "none" });
	});

	it("a pending host grant holds — natively and through the mcp meta-tool", () => {
		const pending = '{"call_id":"x","decided_at":null,"verdict":"pending"}';
		expect(classifyHandback([user("go"), called("c1", "mcp__hive__request_host"), result("c1", "mcp__hive__request_host", pending), said("Requested dev01 access.")]))
			.toMatchObject({ kind: "human", reason: "grant" });
		expect(classifyHandback([user("go"), called("c1", "mcp", { tool: "hive_request_credential" }), result("c1", "mcp", pending), said("Requested.")]))
			.toMatchObject({ kind: "human", reason: "grant" });
	});

	it("a grant decided by a later poll does not hold", () => {
		const branch = [
			user("go"),
			called("c1", "mcp__hive__request_host"),
			result("c1", "mcp__hive__request_host", '{"verdict": "pending"}'),
			called("c2", "mcp__hive__get_host_request"),
			result("c2", "mcp__hive__get_host_request", '{"verdict": "approve"}'),
			said("Access granted; running the probe next."),
		];
		expect(classifyHandback(branch)).toEqual({ kind: "none" });
	});

	it("provisioning that is merely pending is not a grant", () => {
		const branch = [
			user("go"),
			called("c1", "mcp__hive__request_resource"),
			result("c1", "mcp__hive__request_resource", '{"state": "pending"}'),
			said("Provisioning started."),
		];
		expect(classifyHandback(branch)).toEqual({ kind: "none" });
	});

	it("an unanswered plan_ask holds; an answered one does not", () => {
		const ask = (text: string) => [user("go"), called("c1", "plan_ask"), result("c1", "plan_ask", text), said("Noted.")];
		expect(classifyHandback(ask("Which schema?\n\n1. A\n2. B"))).toMatchObject({ reason: "question", structured: true });
		expect(classifyHandback(ask("The user answered: A"))).toEqual({ kind: "none" });
	});
});

describe("classifyHandback — an ask late in the run", () => {
	it("holds as a soft wait when the final word does not repeat it", () => {
		const branch = [
			user("go"),
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Waiting for the controller's schema-repair reservation." }, { type: "toolCall", id: "c1", name: "mcp__hive__message_teammate", arguments: {} }], stopReason: "toolUse" } },
			result("c1", "mcp__hive__message_teammate", "queued"),
			said("Final-head PR CI #4401 is still running. No merge or deployment."),
		];
		const handback = classifyHandback(branch);
		expect(handback).toMatchObject({ kind: "human", reason: "waiting" });
		expect(isFirmHandback(handback)).toBe(false); // a CI completion must still land
	});

	it("does not reach back further than the run's last two messages", () => {
		const branch = [
			user("go"),
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Aligning v2 needs your approval." }, { type: "toolCall", id: "c1", name: "bash", arguments: {} }], stopReason: "toolUse" } },
			result("c1", "bash", "ok"),
			called("c2", "bash"),
			result("c2", "bash", "ok"),
			called("c3", "edit"),
			result("c3", "edit", "ok"),
			said("Implemented and tested."),
		];
		expect(classifyHandback(branch)).toEqual({ kind: "none" });
	});

	it("reads 'awaiting scope confirmation' as a request", () => {
		expect(classifyText("Evidence updated. Awaiting scope confirmation for CLI parity.").kind).toBe("human");
	});
});

describe("handbackClass", () => {
	it("separates a structured gate from a prose request", () => {
		const plan = classifyHandback([
			user("plan it"),
			called("c1", "plan_ready"),
			result("c1", "plan_ready", "Plan is ready and awaiting approval:\n\nX"),
			said("Here is the plan. Let me know if you want changes."),
		]);
		expect(handbackClass(plan)).toBe("gate");
		expect(handbackClass(classifyText("Let me know which."))).toBe("firm");
	});
});

describe("decideWake", () => {
	const firm = classifyText("Shall I merge?");
	const soft = classifyText("Standing by.");
	const structured = classifyHandback([user("go"), said("", "aborted")]);

	it("a completion wakes through a soft wait but not a firm hand-back", () => {
		expect(decideWake("completion", soft)).toEqual({ wake: true });
		expect(decideWake("completion", firm)).toEqual({ wake: false });
		expect(decideWake("completion", { kind: "machine", reason: "own-work" })).toEqual({ wake: true });
	});

	it("a direct message wakes through prose with a reminder, never through a gate", () => {
		const decision = decideWake("message", firm);
		expect(decision.wake).toBe(true);
		expect(decision.wake && decision.reminder).toMatch(/If it IS that answer, act on it/);
		expect(decideWake("message", structured)).toEqual({ wake: false });
	});
});
