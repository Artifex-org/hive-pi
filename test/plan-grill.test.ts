/**
 * The grill stage (HIV-2080): the third answer to a plan gate.
 *
 * "Not yet — ask me things first" is the answer an operator most often wants to
 * give a plan that is nearly right, and until this it did not exist: the card
 * offered approval or silence. These tests pin the two delivery paths (the Hive
 * doorbell and the local TUI dialog) and, more importantly, the two things that
 * make "requires questions" a fact rather than a suggestion — the plan cannot be
 * re-presented, by EITHER route, until the agent has actually asked something.
 *
 * Same harness as plan-approve-flow: two real extension factories, one fake pi.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import agendaExtension from "../extensions/agenda/index.ts";
import planExtension from "../extensions/plan/index.ts";
import {
	PLAN_APPROVED_CHANNEL,
	PLAN_CONTROL_CHANNEL,
	PLAN_GRILL_CHANNEL,
} from "../extensions/hive-common/channels.ts";
import { classifyTool } from "../extensions/plan/policy.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

const originalHiveLaunchId = process.env.HIVE_LAUNCH_ID;

beforeEach(() => {
	delete process.env.HIVE_LAUNCH_ID;
});

afterEach(() => {
	if (originalHiveLaunchId === undefined) delete process.env.HIVE_LAUNCH_ID;
	else process.env.HIVE_LAUNCH_ID = originalHiveLaunchId;
});

type ToolExecute = (
	id: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
	onUpdate?: unknown,
	ctx?: ExtensionContext,
) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;

function toolOf(fake: FakePi, name: string): ToolExecute {
	const tool = fake.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return (tool.definition as { execute: ToolExecute }).execute;
}

/** A ctx for direct tool execution. `confirm`/`select` are per-test. */
function toolCtx(ui: Partial<Record<string, unknown>> = {}): ExtensionContext {
	return {
		mode: "tui",
		cwd: "/tmp/fake-repo",
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
		ui: {
			confirm: async () => true,
			select: async () => undefined,
			notify: () => {},
			setWidget: () => {},
			setStatus: () => {},
			...ui,
		},
		sessionManager: { getEntries: () => [], getBranch: () => [] },
	} as unknown as ExtensionContext;
}

async function bootBoth(): Promise<FakePi> {
	const fake = createFakePi();
	planExtension(fake.api);
	agendaExtension(fake.api);
	await fake.emit({ type: "session_start", reason: "new" });
	return fake;
}

const PLAN_OPS = {
	ops: [
		{ op: "header", title: "Grill me", goal: "The plan survives an interrogation." },
		{
			op: "upsert",
			id: "steps",
			block: { type: "steps", steps: [{ title: "wire the verb" }, { title: "pin the gate" }] },
		},
	],
};

/** Enter plan mode, write a two-step plan, present it. Leaves it at `ready`. */
async function planToReady(fake: FakePi, ctx: ExtensionContext): Promise<void> {
	fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "enter" });
	await toolOf(fake, "plan_write")("w1", PLAN_OPS, undefined, undefined, ctx);
	// `rpc` takes the unattended branch: the plan is presented and left waiting,
	// which is the state a Hive operator is looking at when they click.
	await toolOf(fake, "plan_ready")("r1", {}, undefined, undefined, { ...ctx, mode: "rpc" } as ExtensionContext);
}

function grillEvents(fake: FakePi) {
	return fake.busEvents.filter((event) => event.name === PLAN_GRILL_CHANNEL);
}

function kicks(fake: FakePi) {
	return fake.messages.filter((message) => message.content.includes("asked to be GRILLED"));
}

describe("the grill verb", () => {
	it("declines the plan, keeps read-only mode, and asks agenda for a turn", async () => {
		const fake = await bootBoth();
		const ctx = toolCtx();
		await planToReady(fake, ctx);

		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "grill" });

		// Counters only — the goal sentence must not ride the bus.
		expect(grillEvents(fake)).toHaveLength(1);
		const payload = grillEvents(fake)[0].payload as { stepCount: number; round: number };
		expect(payload.stepCount).toBe(2);
		expect(payload.round).toBe(1);
		expect(JSON.stringify(payload)).not.toContain("interrogation");

		// Nothing was approved.
		expect(fake.busEvents.some((event) => event.name === PLAN_APPROVED_CHANNEL)).toBe(false);
		// Read-only mode is still ON: a decline that handed back the write tools
		// would be an approval with extra steps.
		const [verdict] = await fake.emit({ type: "tool_call", toolName: "edit", input: {} });
		expect((verdict as { block?: boolean } | undefined)?.block).toBe(true);

		// agenda injected exactly one turn, and it tells the agent what to do.
		expect(kicks(fake)).toHaveLength(1);
		expect(kicks(fake)[0].options?.triggerTurn).toBe(true);
		expect(kicks(fake)[0].content).toContain("ask_user_question");
	});

	it("refuses to re-present the plan until the agent has actually asked something", async () => {
		const fake = await bootBoth();
		const ctx = toolCtx();
		await planToReady(fake, ctx);
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "grill" });

		// The shortcut this gate exists to close: same document, straight back to
		// the gate. The plan was decision-complete in the MODEL's reading, which is
		// precisely the disagreement the user clicked the button about.
		const refused = await toolOf(fake, "plan_ready")("r2", {}, undefined, undefined, ctx);
		expect(refused.content[0].text).toContain("asked to be grilled");
		expect(refused.content[0].text).toContain("ask_user_question");

		// And the documented back door — setting the phase through plan_write — is
		// closed too, without discarding the rest of the patch.
		const held = await toolOf(fake, "plan_write")(
			"w2",
			{ ops: [{ op: "header", title: "Renamed under grill", phase: "ready" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(held.content[0].text).toContain("stayed `drafting`");
		expect(held.content[0].text).toContain("Renamed under grill");

		// Ask, and the gate opens.
		await fake.emit({ type: "tool_call", toolName: "ask_user_question", input: {} });
		const presented = await toolOf(fake, "plan_ready")("r3", {}, undefined, undefined, {
			...ctx,
			mode: "rpc",
		} as ExtensionContext);
		expect(presented.content[0].text).toContain("awaiting approval");
	});

	it("lets a dismissed question pay the debt, so nobody is trapped in the mode", async () => {
		// The tool_call hook sees the CALL, not its answer, and that is deliberate:
		// an operator who asked to be grilled is allowed to stop answering. The
		// alternative is a session that cannot leave a mode the user themselves
		// abandoned.
		const fake = await bootBoth();
		const ctx = toolCtx();
		await planToReady(fake, ctx);
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "grill" });

		await fake.emit({ type: "tool_call", toolName: "ask_user_question", input: {} });
		const presented = await toolOf(fake, "plan_ready")("r2", {}, undefined, undefined, {
			...ctx,
			mode: "rpc",
		} as ExtensionContext);
		expect(presented.content[0].text).toContain("awaiting approval");
	});

	it("counts the rounds, so a second decline does not read as the first", async () => {
		const fake = await bootBoth();
		const ctx = toolCtx();
		await planToReady(fake, ctx);
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "grill" });
		await fake.emit({ type: "tool_call", toolName: "ask_user_question", input: {} });
		await toolOf(fake, "plan_ready")("r2", {}, undefined, undefined, { ...ctx, mode: "rpc" } as ExtensionContext);
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "grill" });

		expect(grillEvents(fake)).toHaveLength(2);
		expect((grillEvents(fake)[1].payload as { round: number }).round).toBe(2);
		expect(kicks(fake)[1].content).toContain("round 2");
	});

	it("ignores a grill for a plan nobody is waiting on", async () => {
		// Every card in a Hive transcript stays clickable forever — they are
		// historical rows, not a live queue. A stale click must land on nothing
		// rather than drag a session back out of execution.
		const fake = await bootBoth();
		const ctx = toolCtx();
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "enter" });
		await toolOf(fake, "plan_write")("w1", PLAN_OPS, undefined, undefined, ctx);

		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "grill" });
		expect(grillEvents(fake)).toHaveLength(0);
		expect(kicks(fake)).toHaveLength(0);

		// Approved is likewise past the point of declining.
		await toolOf(fake, "plan_ready")("r1", {}, undefined, undefined, ctx);
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "grill" });
		expect(grillEvents(fake)).toHaveLength(0);
	});

	it("forgets the debt when the plan is approved, so the NEXT plan is not gated", async () => {
		const fake = await bootBoth();
		const ctx = toolCtx();
		await planToReady(fake, ctx);
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "grill" });
		// Approved from the browser without ever answering — the operator changed
		// their mind, which is allowed.
		await fake.emit({ type: "tool_call", toolName: "ask_user_question", input: {} });
		await toolOf(fake, "plan_ready")("r2", {}, undefined, undefined, { ...ctx, mode: "rpc" } as ExtensionContext);
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "approve" });

		// A whole new plan, in a fresh plan mode: nothing from the old grill
		// survives to refuse it.
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "enter" });
		await toolOf(fake, "plan_write")("w9", PLAN_OPS, undefined, undefined, ctx);
		const presented = await toolOf(fake, "plan_ready")("r9", {}, undefined, undefined, {
			...ctx,
			mode: "rpc",
		} as ExtensionContext);
		expect(presented.content[0].text).toContain("awaiting approval");
	});
});

describe("the grill verb at a local TUI", () => {
	it("offers it on a decline and answers in the tool result, not as a second turn", async () => {
		const fake = await bootBoth();
		let offered: string[] = [];
		const ctx = toolCtx({
			confirm: async () => false,
			select: async (_title: string, options: string[]) => {
				offered = options;
				return options[0];
			},
		});
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "enter" });
		await toolOf(fake, "plan_write")("w1", PLAN_OPS, undefined, undefined, ctx);
		const result = await toolOf(fake, "plan_ready")("r1", {}, undefined, undefined, ctx);

		expect(offered[0]).toContain("Grill me");
		expect(result.content[0].text).toContain("asked to be GRILLED");
		// The instruction rides back as THIS tool's result. Emitting the doorbell
		// as well would have agenda inject the same text again, as a separate
		// turn, on top of the one already in flight.
		expect(grillEvents(fake)).toHaveLength(0);
		expect(kicks(fake)).toHaveLength(0);
		// And it is still a decline: read-only stays on, nothing is approved.
		expect(fake.busEvents.some((event) => event.name === PLAN_APPROVED_CHANNEL)).toBe(false);
		const [verdict] = await fake.emit({ type: "tool_call", toolName: "edit", input: {} });
		expect((verdict as { block?: boolean } | undefined)?.block).toBe(true);
	});

	it("treats a dismissed follow-up as an ordinary decline", async () => {
		const fake = await bootBoth();
		const ctx = toolCtx({ confirm: async () => false, select: async () => undefined });
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "enter" });
		await toolOf(fake, "plan_write")("w1", PLAN_OPS, undefined, undefined, ctx);
		const result = await toolOf(fake, "plan_ready")("r1", {}, undefined, undefined, ctx);
		expect(result.content[0].text).toContain("declined the plan");
		expect(grillEvents(fake)).toHaveLength(0);
	});

	it("`/plan grill` sends a ready plan back and rings the doorbell", async () => {
		const fake = await bootBoth();
		const ctx = toolCtx();
		await planToReady(fake, ctx);

		const command = fake.commands.get("plan");
		await command!.handler("grill", ctx);
		expect(grillEvents(fake)).toHaveLength(1);
		// Nothing is holding a turn open here, so unlike the dialog branch the
		// doorbell IS the delivery.
		expect(kicks(fake)).toHaveLength(1);
	});
});

describe("plan mode's allowlist", () => {
	it("permits ask_user_question", () => {
		// It was denied until HIV-2080 — the same defect HIV-1313 found with
		// `advisor`. A mode whose own instructions tell the agent to ask the user
		// something, and then blocks the only tool that asks, is not restrictive;
		// it is broken.
		expect(classifyTool("ask_user_question").allowed).toBe(true);
	});
});
