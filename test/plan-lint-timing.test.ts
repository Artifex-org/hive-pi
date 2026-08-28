/**
 * WHEN the composition lint speaks, which is the whole of its effect.
 *
 * The lint's rules were already tested (`plan-lint.test.ts`); what was never
 * tested — and what measurement showed was the actual defect — is that it only
 * ever spoke from `plan_ready`, the call that PARKS the turn on the operator's
 * decision. Over 38 sessions on 2026-08-28: 25 plans reached `plan_ready`, and
 * 17 of them (68%) arrived carrying steps with neither a reason nor one piece
 * of evidence. Three evidence blocks in total existed before the moment of
 * presentation, against fourteen written afterwards — so 79% of what a plan
 * knows showed up after the reader had already answered it.
 *
 * These tests pin the fix: the same advice, on the composing writes, where
 * acting on it is free — and silent everywhere it would be nagging.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import planExtension from "../extensions/plan/index.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

type ToolExecute = (
	id: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
	onUpdate?: unknown,
	ctx?: ExtensionContext,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

function toolOf(fake: FakePi, name: string): ToolExecute {
	const tool = fake.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return (tool.definition as { execute: ToolExecute }).execute;
}

function toolCtx(): ExtensionContext {
	return {
		mode: "tui",
		cwd: "/tmp/fake-repo",
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
		ui: { confirm: async () => true, notify: () => {}, setWidget: () => {}, setStatus: () => {} },
		sessionManager: { getEntries: () => [], getBranch: () => [] },
	} as unknown as ExtensionContext;
}

async function boot(): Promise<FakePi> {
	const fake = createFakePi();
	planExtension(fake.api);
	await fake.emit({ type: "session_start", reason: "new" });
	return fake;
}

/** Five steps: over `OWES_AN_EXPLANATION`, so the absence rules apply. */
const FIVE_STEPS = {
	op: "upsert",
	id: "steps",
	block: {
		type: "steps",
		steps: [
			{ id: "s1", title: "Trace the guard" },
			{ id: "s2", title: "Add the helper" },
			{ id: "s3", title: "Route the callers" },
			{ id: "s4", title: "Write the test" },
			{ id: "s5", title: "Open the PR" },
		],
	},
};

const write = (fake: FakePi, id: string, ops: unknown[]) =>
	toolOf(fake, "plan_write")(id, { ops }, undefined, undefined, toolCtx());

describe("the composition lint reaches the model while it is still composing", () => {
	it("advises on the write that builds a bare plan, not only at plan_ready", async () => {
		const fake = await boot();
		const result = await write(fake, "w1", [FIVE_STEPS]);
		const text = result.content[0].text;
		expect(text).toContain("Advisory composition lint");
		// Both absence rules: no reasoning, and no evidence of any kind.
		expect(text).toContain("never says why");
		expect(text).toContain("prose and a checklist");
	});

	it("says each thing once, so building the plan in pieces is not punished", async () => {
		const fake = await boot();
		const first = await write(fake, "w1", [FIVE_STEPS]);
		expect(first.content[0].text).toContain("never says why");
		// The prompt teaches incremental building; a second write that has not
		// fixed anything must not repeat the same two sentences.
		const second = await write(fake, "w2", [{ op: "header", title: "Fix the branch policy" }]);
		expect(second.content[0].text).not.toContain("Advisory composition lint");
	});

	it("stays silent once the plan has been approved", async () => {
		const fake = await boot();
		await write(fake, "w1", [FIVE_STEPS]);
		// Approval is not model-writable through the tool, so drive the phase the
		// way the approval path does, then tick a step as an executing session does.
		fake.api.events.emit("plan:control", { action: "approve" });
		const tick = await write(fake, "w2", [{ op: "item", item: { id: "s1", status: "in_progress" } }]);
		expect(tick.content[0].text).not.toContain("Advisory composition lint");
	});

	it("never asks a mirrored todo list for a diagram", async () => {
		const fake = await boot();
		// `origin` is what the TodoWrite façade stamps; a document made only of
		// those is a todo list, and nagging it is how a linter loses its reader.
		const result = await write(fake, "w1", [
			{
				op: "lane",
				id: "todos",
				kind: "execute",
				origin: "mirror",
				items: [
					{ id: "t1", title: "One" },
					{ id: "t2", title: "Two" },
					{ id: "t3", title: "Three" },
					{ id: "t4", title: "Four" },
				],
			},
		]);
		expect(result.content[0].text).not.toContain("Advisory composition lint");
	});

	it("speaks again for a NEW plan in the same session", async () => {
		const fake = await boot();
		await write(fake, "w1", [FIVE_STEPS]);
		// A second plan is a second document with its own reader. The dedupe is
		// per plan, and the reset rides the write that lands on an empty one.
		await fake.emit({ type: "session_start", reason: "new" });
		const again = await write(fake, "w2", [FIVE_STEPS]);
		expect(again.content[0].text).toContain("Advisory composition lint");
	});
});
