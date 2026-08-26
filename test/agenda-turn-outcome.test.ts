/**
 * "Did the last turn actually run?" — the precondition on automatic re-entry.
 *
 * Reproduces session 019fd3bc (2026-08-05), where a Ctrl+C mid-tool-call left an
 * orphaned `function_call_output` and every later turn was refused by the
 * provider. Because a refused turn appends no evidence, the evaluator kept
 * truthfully answering "not met" and the driver kept injecting: eight identical
 * failures plus eight evaluator calls against a transcript no continuation could
 * repair.
 */

import { describe, expect, it } from "vitest";
import { turnFailureOf } from "../extensions/agenda/turn-outcome.ts";

const assistant = (stopReason?: string, errorMessage?: string) => ({
	message: { role: "assistant", content: [{ type: "text", text: "x" }], stopReason, errorMessage },
});
const user = (text: string) => ({ message: { role: "user", content: text } });
const toolResult = () => ({ message: { role: "toolResult", content: "ok" } });

describe("turnFailureOf", () => {
	it("reports nothing for a turn that completed", () => {
		expect(turnFailureOf([user("go"), assistant("stop")])).toBeUndefined();
	});

	it("reports nothing mid-tool-use — that turn is still working", () => {
		expect(turnFailureOf([user("go"), assistant("toolUse")])).toBeUndefined();
	});

	it("reports `error` for a provider refusal", () => {
		const branch = [
			user("continue"),
			assistant("error", "Codex error: No tool call found for function call output with call_id call_I9zi"),
		];
		expect(turnFailureOf(branch)).toBe("error");
	});

	it("reports `aborted` when the human stopped the turn", () => {
		expect(turnFailureOf([user("go"), assistant("aborted", "Operation aborted")])).toBe("aborted");
	});

	it("reads only the NEWEST assistant turn", () => {
		// An error the human has since worked past must not suppress the loop
		// forever — otherwise one bad turn disarms the goal for the session.
		const branch = [assistant("error", "transient"), user("try again"), assistant("stop")];
		expect(turnFailureOf(branch)).toBeUndefined();
	});

	it("is not confused by tool results after the assistant message", () => {
		expect(turnFailureOf([assistant("error", "boom"), toolResult()])).toBe("error");
	});

	it("reports nothing for a branch with no assistant turn at all", () => {
		expect(turnFailureOf([user("first message of the session")])).toBeUndefined();
		expect(turnFailureOf([])).toBeUndefined();
	});

	it("ignores stopReasons it does not recognise", () => {
		// Unknown values are pi's business, not ours; treating an unfamiliar
		// reason as failure would disarm the loop on the next pi version bump.
		expect(turnFailureOf([assistant("length")])).toBeUndefined();
		expect(turnFailureOf([assistant(undefined)])).toBeUndefined();
	});

	it("survives entries that are not shaped like messages", () => {
		expect(turnFailureOf([null, undefined, 42, { nope: true }, assistant("aborted")])).toBe("aborted");
	});
});

describe("the burn loop this prevents", () => {
	it("keeps reporting `error` for every repeat of the identical failure", () => {
		// The real session's tail: one abort, then eight identical refusals. Each
		// one must independently say "not evidence", because each is separately
		// offered to the driver.
		const orphanError = "Codex error: No tool call found for function call output with call_id call_I9zi";
		let branch: unknown[] = [user("continue"), assistant("aborted", "Operation aborted")];
		expect(turnFailureOf(branch)).toBe("aborted");

		for (let i = 0; i < 8; i++) {
			branch = [...branch, user("continue"), assistant("error", orphanError)];
			expect(turnFailureOf(branch)).toBe("error");
		}
	});
});
