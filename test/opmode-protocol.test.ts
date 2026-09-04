import { describe, expect, it } from "vitest";
import opmodeExtension from "../extensions/opmode/index.ts";
import { buildOpModePrompt } from "../extensions/opmode/prompt.ts";
import { createFakePi } from "./fake-pi.ts";

type Execute = (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; details: { hive_widget?: { spec?: { stage?: string } } } }>;

function evidence(pi: ReturnType<typeof createFakePi>): Execute {
	const tool = pi.tools.find((entry) => entry.name === "bugfix_evidence");
	if (!tool) throw new Error("bugfix_evidence was not registered");
	return tool.definition.execute as Execute;
}

async function result(pi: ReturnType<typeof createFakePi>, id: string, name: string, isError: boolean) {
	await pi.emit({ type: "tool_result", toolCallId: id, toolName: name, isError, content: [{ type: "text", text: isError ? "failed" : "passed" }] });
}

describe("bugfix evidence protocol", () => {
	it("requires distinct failing and passing runs bound by one stable reproduction key", async () => {
		const pi = createFakePi();
		opmodeExtension(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await pi.runCommand("mode", "bugfix");
		const record = evidence(pi);

		await result(pi, "fail-1", "bash", true);
		expect((await record("e1", { phase: "reproduce", tool_call_id: "fail-1", reproduction_key: "targeted-test" })).details.hive_widget?.spec?.stage).toBe("hypothesize");
		expect((await record("e2", { phase: "hypothesize", tool_call_id: "fail-1", hypothesis: "state leaks" })).details.hive_widget?.spec?.stage).toBe("instrument");
		await result(pi, "instrument-1", "bash", false);
		await record("e3", { phase: "instrument", tool_call_id: "instrument-1" });
		await record("e4", { phase: "confirm", tool_call_id: "instrument-1", hypothesis: "state leaks" });

		const sameCall = await record("e5", { phase: "reverify", tool_call_id: "fail-1", reproduction_key: "targeted-test" });
		expect(sameCall.details.hive_widget).toBeUndefined();
		await result(pi, "pass-1", "bash", false);
		expect((await record("e6", { phase: "reverify", tool_call_id: "pass-1", reproduction_key: "targeted-test" })).details.hive_widget?.spec?.stage).toBe("done");
	});
});

/** Start a session already in bugfix mode, and hand back its evidence tool. */
async function inBugfix(pi: ReturnType<typeof createFakePi>): Promise<Execute> {
	opmodeExtension(pi.api);
	await pi.emit({ type: "session_start", reason: "startup" });
	await pi.runCommand("mode", "bugfix");
	return evidence(pi);
}

const said = (out: Awaited<ReturnType<Execute>>) => out.content[0]?.text ?? "";

/**
 * The protocol is mandatory and discoverable only by trial, so its REFUSALS are
 * its documentation — and for the whole of HIV-3078's window they were the
 * wrong documentation. `reproduction_key` is `Type.Optional` in the schema yet
 * mandatory for the reproduce phase, and the refusal that fired when it was
 * missing never named it; every other wrong ordering collapsed into one
 * sentence listing three possible faults without saying which one happened.
 * An agent that answered the candidate-id refusal correctly was told, on the
 * very next call, that it needed "an actual failing result" — which it had.
 *
 * These pin the two properties that turn the dead end into a retry: a refusal
 * names the argument it is missing, and two different wrong orderings are two
 * different messages.
 */
describe("bugfix evidence refusals name what is actually wrong", () => {
	it("names reproduction_key rather than blaming the id that was right", async () => {
		const pi = createFakePi();
		const record = await inBugfix(pi);
		await result(pi, "fail-1", "bash", true);

		const out = await record("e1", { phase: "reproduce", tool_call_id: "fail-1" });

		expect(out.details.hive_widget).toBeUndefined();
		expect(said(out)).toContain("reproduction_key");
		// The id WAS observed and WAS failing; saying otherwise is what sent
		// agents back to re-listing candidate ids they already had.
		expect(said(out)).not.toContain("was not observed");
	});

	it("says the run passed, and does not offer that same run as the example", async () => {
		const pi = createFakePi();
		const record = await inBugfix(pi);
		await result(pi, "ok-1", "bash", false);

		const out = await record("e1", { phase: "reproduce", tool_call_id: "ok-1", reproduction_key: "targeted-test" });

		expect(out.details.hive_widget).toBeUndefined();
		expect(said(out)).toContain("without failing");
		// Echoing ok-1 back as the example would recommend the exact call that
		// was just refused — the self-contradiction, one refusal further on.
		expect(said(out).split("Example:")[1] ?? "").not.toContain("ok-1");
	});

	it("distinguishes two wrong orderings instead of collapsing them", async () => {
		const pi = createFakePi();
		const record = await inBugfix(pi);
		await result(pi, "fail-1", "bash", true);
		await record("e1", { phase: "reproduce", tool_call_id: "fail-1", reproduction_key: "targeted-test" });
		// The machine is now waiting for "hypothesize".
		await result(pi, "other-1", "bash", false);

		const tooFar = said(await record("e2", { phase: "instrument", tool_call_id: "other-1" }));
		const wayTooFar = said(await record("e3", { phase: "reverify", tool_call_id: "other-1", reproduction_key: "targeted-test" }));
		const rightPhaseNoPayload = said(await record("e4", { phase: "hypothesize", tool_call_id: "other-1" }));

		expect(tooFar).not.toBe(wayTooFar);
		expect(rightPhaseNoPayload).not.toBe(tooFar);
		expect(tooFar).toContain("instrument");
		expect(wayTooFar).toContain("reverify");
		// Each names the phase the machine is actually waiting for — asserted on
		// the whole clause, because the order line mentions every phase and a
		// bare `toContain("hypothesize")` would pass on that alone.
		expect(tooFar).toContain('waiting for phase "hypothesize"');
		expect(wayTooFar).toContain('waiting for phase "hypothesize"');
		// And the one that had the right phase says which FIELD was missing.
		expect(rightPhaseNoPayload).toContain("hypothesis");
	});
});

/**
 * The prompt is not the only place that prescribed the refused call. The deny an
 * agent hits on its FIRST attempted edit, and the snippet the tool contributes to
 * the system prompt, both pointed at `bugfix_root_cause` alone — which refuses
 * until `bugfix_evidence` has walked every phase. Two refusals for the first two
 * moves is the same manufactured dead end, one layer out.
 */
describe("the strings that route an agent into the protocol", () => {
	it("denies the first edit with the evidence protocol, not just the call that refuses", async () => {
		const pi = createFakePi();
		await inBugfix(pi);

		const verdicts = await pi.emit({ type: "tool_call", toolName: "edit", input: { path: "a.ts" } });
		const denied = verdicts.find(Boolean) as { block?: boolean; reason?: string } | undefined;

		expect(denied?.block).toBe(true);
		expect(denied?.reason).toContain("bugfix_evidence");
		expect(denied?.reason).toContain("reproduce");
	});

	it("says the same thing in the prompt snippet the tool contributes", () => {
		const pi = createFakePi();
		opmodeExtension(pi.api);
		const snippet = pi.tools.find((entry) => entry.name === "bugfix_root_cause")?.definition.promptSnippet ?? "";
		expect(snippet).toContain("bugfix_evidence");
	});
});

/**
 * The prompt taught step 4 as "record it with `bugfix_root_cause`" — a call the
 * state machine refuses until `bugfix_evidence` has walked all four phases. A
 * plain string assertion, because this is exactly the drift that recurs: the
 * gate moves and the prose describing it does not.
 */
describe("the bugfix prompt teaches the protocol the machine enforces", () => {
	it("names bugfix_evidence, its reproduction_key, and every phase in order", () => {
		const prompt = buildOpModePrompt("bugfix") ?? "";
		expect(prompt).toContain("bugfix_evidence");
		expect(prompt).toContain("reproduction_key");
		const phases = ["reproduce", "hypothesize", "instrument", "confirm", "reverify"];
		let at = -1;
		for (const phase of phases) {
			const next = prompt.indexOf(phase, at + 1);
			expect(next, `${phase} must appear, after the phase before it`).toBeGreaterThan(at);
			at = next;
		}
	});
});
