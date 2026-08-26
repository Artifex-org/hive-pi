import { describe, expect, it } from "vitest";

import { flattenConversation } from "./history.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as never;
const assistant = (text: string) =>
	({ role: "assistant", content: [{ type: "text", text }] }) as never;
const called = (name: string, args: unknown) =>
	({
		role: "assistant",
		content: [{ type: "toolCall", id: "c1", name, arguments: args }],
	}) as never;
const result = (toolName: string, text: string, isError = false) =>
	({
		role: "toolResult",
		toolCallId: "c1",
		toolName,
		content: [{ type: "text", text }],
		isError,
	}) as never;

describe("flattening a conversation for Cursor", () => {
	// Cursor keeps no state across turns: a pi tool call ENDS the turn, and the
	// next one is rebuilt from this text alone. Everything the model needs to
	// know it already acted must survive here, or it acts again.
	it("keeps the tool CALL and labels the RESULT with its tool name", () => {
		const out = flattenConversation([
			user("What is 6 times 7?"),
			called("record_answer", { answer: "42" }),
			result("record_answer", "recorded: 42"),
		]);
		expect(out).toContain("[assistant called]\nrecord_answer({\"answer\":\"42\"})");
		// The label is the fix. Flattened as `[user]`, the result read as the user
		// saying "recorded: 42" -- the model never connected it to its own call and
		// re-called the tool 25-33 times until the run timed out.
		expect(out).toContain("[tool record_answer returned]\nrecorded: 42");
		expect(out).not.toContain("[user]\nrecorded: 42");
	});

	it("marks a failed tool result as failed", () => {
		// Distinguished so the model retries deliberately rather than assuming
		// success and moving on -- the opposite failure to the loop.
		const out = flattenConversation([
			user("do it"),
			called("record_answer", {}),
			result("record_answer", "missing required argument", true),
		]);
		expect(out).toContain("[tool record_answer FAILED]\nmissing required argument");
	});

	it("still reports a result that carried no text", () => {
		// An empty result rendered as nothing is indistinguishable from the tool
		// never having run, which is exactly the ambiguity that causes a re-call.
		const out = flattenConversation([
			user("go"),
			called("noisy", {}),
			result("noisy", ""),
		]);
		expect(out).toContain("[tool noisy returned]\n(no output)");
	});

	it("leaves a single user turn looking like an ordinary prompt", () => {
		// The common case is one message; scaffolding it as a transcript would
		// change what the model is being asked.
		expect(flattenConversation([user("just answer this")])).toBe("just answer this");
	});

	it("drops the system message, which travels as the prompt blob", () => {
		const out = flattenConversation([
			{ role: "system", content: [{ type: "text", text: "SYSTEM" }] } as never,
			user("hi"),
		]);
		expect(out).not.toContain("SYSTEM");
	});

	it("labels an ordinary assistant turn", () => {
		const out = flattenConversation([user("hi"), assistant("hello"), user("again")]);
		expect(out).toContain("[assistant]\nhello");
	});
});
