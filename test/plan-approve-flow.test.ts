/**
 * End-to-end pin of the conductor's plan integration on the fake bus:
 * doorbell → plan mode entry → plan_ready → approval → auto-goal +
 * orchestration consent + the execute kick. Two real extension factories, one
 * fake pi, zero child processes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import agendaExtension from "../extensions/agenda/index.ts";
import planExtension from "../extensions/plan/index.ts";
import { PLAN_APPROVED_CHANNEL, PLAN_CONTROL_CHANNEL } from "../extensions/hive-common/channels.ts";
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
) => Promise<{
	content: Array<{ type: string; text: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
}>;

function toolOf(fake: FakePi, name: string): ToolExecute {
	const tool = fake.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return (tool.definition as { execute: ToolExecute }).execute;
}

/** Minimal hand-rolled ctx for direct tool execution. Confirm answers yes. */
function toolCtx(overrides: Partial<Record<string, unknown>> = {}): ExtensionContext {
	return {
		mode: "tui",
		cwd: "/tmp/fake-repo",
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
		ui: {
			confirm: async () => true,
			notify: () => {},
			setWidget: () => {},
			setStatus: () => {},
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
		},
		...overrides,
	} as unknown as ExtensionContext;
}

async function bootBoth(): Promise<FakePi> {
	const fake = createFakePi();
	planExtension(fake.api);
	agendaExtension(fake.api);
	await fake.emit({ type: "session_start", reason: "new" });
	return fake;
}

describe("plan approval flow", () => {
	it("the control doorbell enters plan mode and narrows tools", async () => {
		const fake = await bootBoth();
		expect(fake.activeTools).toContain("goal_set");
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "enter" });
		// Write-capable agenda tools stay out; plan tools stay in.
		expect(fake.activeTools).toContain("plan_write");
		expect(fake.activeTools).toContain("plan_ready");
	});

	it("plan_ready outside plan mode refuses", async () => {
		const fake = await bootBoth();
		const result = await toolOf(fake, "plan_ready")("t0", {}, undefined, undefined, toolCtx());
		expect(result.content[0].text).toContain("Not in plan mode");
	});

	// The refusal has to be an ANSWER (HIV-1967). `plan_write` has no mode guard,
	// so an agent can build a real plan and then find `plan_ready` closed — which
	// is what happened to two Hive-launched agents on 2026-08-16, both stopping
	// right there. What they wanted was permission to proceed, and they already
	// had it: plan mode is what WITHHOLDS the write tools, so outside it nothing
	// was ever withheld. The message has to say that, or the caller reasonably
	// concludes it is stuck.
	it("tells an agent holding a real plan outside plan mode that nothing is gating it", async () => {
		const fake = await bootBoth();
		const ctx = toolCtx();
		await toolOf(fake, "plan_write")(
			"w0",
			{
				ops: [
					{ op: "header", title: "Fix the branch policy", goal: "Get the PR gate green." },
					{
						op: "upsert",
						id: "steps",
						block: { type: "steps", steps: [{ id: "s1", text: "Trace the guard" }, { id: "s2", text: "Fix it" }] },
					},
				],
			},
			undefined,
			undefined,
			ctx,
		);
		const result = await toolOf(fake, "plan_ready")("t0", {}, undefined, undefined, ctx);
		const out = result.content[0].text as string;

		// It still refuses, and still says why.
		expect(out).toContain("Not in plan mode");
		// But it resolves the caller's actual question instead of ending there.
		expect(out).toMatch(/nothing was withheld|no approval gate/i);
		expect(out).toContain("saved");
		// And names the way in, for a caller that genuinely wants the gate.
		expect(out).toContain("/plan");
	});

	// The empty-plan case keeps its own wording — "build it first" and "nothing
	// is gating you" are different next moves, and collapsing them would send a
	// caller with no plan off to execute one.
	it("distinguishes an empty plan from a real one outside plan mode", async () => {
		const fake = await bootBoth();
		const result = await toolOf(fake, "plan_ready")("t0", {}, undefined, undefined, toolCtx());
		const out = result.content[0].text as string;
		expect(out).toContain("plan is empty");
		expect(out).not.toContain("saved");
	});

	it("a Hive-launched session never opens the approval modal, even as a real TUI", async () => {
		// A workstation launch runs pi as a genuine TUI in a tmux pane nobody is
		// watching, so `mode: "tui"` is true and still means unattended. Blocking
		// on ctx.ui.confirm there hangs the session forever: the modal owns stdin,
		// so even queued steering cannot land (HIV-1449).
		const previous = process.env.HIVE_LAUNCH_ID;
		process.env.HIVE_LAUNCH_ID = "4cd46a3c";
		try {
			const fake = await bootBoth();
			fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "enter" });

			let confirmCalls = 0;
			const ctx = toolCtx({
				mode: "tui",
				ui: {
					confirm: async () => {
						confirmCalls += 1;
						return true;
					},
					notify: () => {},
					setWidget: () => {},
					setStatus: () => {},
				},
			});
			await toolOf(fake, "plan_write")(
				"t1",
				{
					ops: [
						{ op: "header", title: "Unattended", goal: "the pane is nobody's" },
						{ op: "upsert", id: "steps", block: { type: "steps", steps: [{ title: "do the thing" }] } },
					],
				},
				undefined,
				undefined,
				ctx,
			);

			const result = await toolOf(fake, "plan_ready")("t2", {}, undefined, undefined, ctx);

			// The modal is the wedge. It must not be opened at all.
			expect(confirmCalls).toBe(0);
			expect(result.content[0].text).toContain("awaiting approval");
			expect(result.content[0].text).toContain("/plan approve");
			// And it must NOT have self-approved: read-only mode is the safety
			// property of plan mode, so the gate moves to /plan approve rather than
			// disappearing.
			expect(result.content[0].text).not.toContain("Plan approved");
			expect(fake.busEvents.find((event) => event.name === PLAN_APPROVED_CHANNEL)).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.HIVE_LAUNCH_ID;
			else process.env.HIVE_LAUNCH_ID = previous;
		}
	});

	it("a developer's own TUI still gets the approval modal", async () => {
		// The counterpart guard: HIVE_URL/HIVE_TOKEN are present in any shell with
		// Hive configured, so keying on those would steal the modal from a human
		// running pi themselves. Only HIVE_LAUNCH_ID marks a managed launch.
		const previous = process.env.HIVE_LAUNCH_ID;
		delete process.env.HIVE_LAUNCH_ID;
		process.env.HIVE_URL = "https://hive.example";
		process.env.HIVE_TOKEN = "hive_notalaunch";
		try {
			const fake = await bootBoth();
			fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "enter" });

			let confirmCalls = 0;
			const ctx = toolCtx({
				mode: "tui",
				ui: {
					confirm: async () => {
						confirmCalls += 1;
						return true;
					},
					notify: () => {},
					setWidget: () => {},
					setStatus: () => {},
				},
			});
			await toolOf(fake, "plan_write")(
				"t1",
				{
					ops: [
						{ op: "header", title: "Attended", goal: "a human is right here" },
						{ op: "upsert", id: "steps", block: { type: "steps", steps: [{ title: "do the thing" }] } },
					],
				},
				undefined,
				undefined,
				ctx,
			);

			const result = await toolOf(fake, "plan_ready")("t2", {}, undefined, undefined, ctx);
			expect(confirmCalls).toBe(1);
			expect(result.content[0].text).toContain("Plan approved");
		} finally {
			if (previous !== undefined) process.env.HIVE_LAUNCH_ID = previous;
		}
	});

	it("approval emits the counters-only event, creates a goal, enables orchestrate, and kicks execution", async () => {
		const fake = await bootBoth();
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "enter" });

		const ctx = toolCtx();
		await toolOf(fake, "plan_write")(
			"t1",
			{
				ops: [
					{ op: "header", title: "Lifecycle", goal: "PR created and `gh pr checks` reports green" },
					{
						op: "upsert",
						id: "steps",
						block: { type: "steps", steps: [{ title: "wire the bus" }, { title: "pin the tests" }] },
					},
				],
			},
			undefined,
			undefined,
			ctx,
		);

		const result = await toolOf(fake, "plan_ready")("t2", {}, undefined, undefined, ctx);
		expect(result.content[0].text).toContain("Plan approved");
		// The approval result carries the browser lifecycle widget envelope.
		const widget = result.details?.hive_widget as { v: number; type: string; spec: { stage: string } };
		expect(widget?.v).toBe(1);
		expect(widget?.type).toBe("lifecycle");
		expect(widget?.spec.stage).toBe("execute");

		const approved = fake.busEvents.find((event) => event.name === PLAN_APPROVED_CHANNEL);
		expect(approved).toBeDefined();
		const payload = approved!.payload as { stepCount: number; orchestrationConsented: boolean };
		expect(payload.stepCount).toBe(2);
		expect(payload.orchestrationConsented).toBe(true);
		// Counters only — the goal sentence must not ride the bus.
		expect(JSON.stringify(payload)).not.toContain("gh pr checks");

		// Agenda reacted: a goal entry was persisted…
		const goalEntry = fake.entries.find((entry) => (entry.data as { kind?: string })?.kind === "goal");
		expect(goalEntry).toBeDefined();
		// …orchestration was consent-enabled…
		expect(fake.activeTools).toContain("orchestrate");
		expect(fake.activeTools).toContain("worker_send");
		// …and the execute kick started a turn.
		const kick = fake.messages.find((message) => message.content.includes("plan is approved"));
		expect(kick).toBeDefined();
		expect(kick!.options?.triggerTurn).toBe(true);
		expect(kick!.content).toContain("orchestrate");
		expect(kick!.content).toContain("maxConcurrent");
	});

	it("a declined confirm keeps plan mode on and enables nothing", async () => {
		const fake = await bootBoth();
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "enter" });
		const ctx = toolCtx({
			ui: {
				confirm: async () => false,
				// A decline now asks a second question — grill, or revise it
				// yourself (HIV-2080). Dismissed here; the grill branch has its own
				// coverage in plan-grill.test.ts.
				select: async () => undefined,
				notify: () => {},
				setWidget: () => {},
				setStatus: () => {},
			},
		});
		await toolOf(fake, "plan_write")(
			"t1",
			{ ops: [{ op: "upsert", id: "steps", block: { type: "steps", steps: [{ title: "a" }, { title: "b" }] } }] },
			undefined,
			undefined,
			ctx,
		);
		const result = await toolOf(fake, "plan_ready")("t2", {}, undefined, undefined, ctx);
		expect(result.content[0].text).toContain("declined");
		expect(fake.busEvents.some((event) => event.name === PLAN_APPROVED_CHANNEL)).toBe(false);
		expect(fake.activeTools).not.toContain("orchestrate");
	});

	it("honours a remote approve request only for a ready plan", async () => {
		const fake = await bootBoth();
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "enter" });
		const ctx = toolCtx();
		await toolOf(fake, "plan_write")(
			"t1",
			{ ops: [{ op: "upsert", id: "steps", block: { type: "steps", steps: [{ title: "only step" }] } }] },
			undefined,
			undefined,
			ctx,
		);
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "approve" });
		expect(fake.busEvents.some((event) => event.name === PLAN_APPROVED_CHANNEL)).toBe(false);
		await toolOf(fake, "plan_ready")("t2", {}, undefined, undefined, { ...ctx, mode: "rpc" });
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "approve" });
		expect(fake.busEvents.some((event) => event.name === PLAN_APPROVED_CHANNEL)).toBe(true);
	});

	it("a single-step plan approves without orchestration consent", async () => {
		const fake = await bootBoth();
		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "enter" });
		const ctx = toolCtx();
		await toolOf(fake, "plan_write")(
			"t1",
			{ ops: [{ op: "upsert", id: "steps", block: { type: "steps", steps: [{ title: "only step" }] } }] },
			undefined,
			undefined,
			ctx,
		);
		await toolOf(fake, "plan_ready")("t2", {}, undefined, undefined, ctx);
		const approved = fake.busEvents.find((event) => event.name === PLAN_APPROVED_CHANNEL);
		expect((approved!.payload as { orchestrationConsented: boolean }).orchestrationConsented).toBe(false);
		expect(fake.activeTools).not.toContain("orchestrate");
		const kick = fake.messages.find((message) => message.content.includes("plan is approved"));
		expect(kick!.content).toContain("subagent");
	});
});

describe("goal_set tool", () => {
	it("bounces an unverifiable condition as an error", async () => {
		const fake = await bootBoth();
		const result = await toolOf(fake, "goal_set")("g1", { condition: "make the code better" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("machine-checkable");
		expect(fake.entries.some((entry) => (entry.data as { kind?: string })?.kind === "goal")).toBe(false);
	});

	it("persists a verifiable goal and returns the lifecycle envelope", async () => {
		const fake = await bootBoth();
		const result = await toolOf(fake, "goal_set")("g2", { condition: "`npm run check` exits 0" });
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("only when Pi becomes idle (agent_settled)");
		expect(result.content[0].text).toContain("does not evaluate active or interrupted tool chains");
		const entry = fake.entries.find((candidate) => (candidate.data as { kind?: string })?.kind === "goal");
		expect(entry).toBeDefined();
		expect((entry!.data as { condition: string }).condition).toBe("`npm run check` exits 0");
		const widget = result.details?.hive_widget as {
			type: string;
			spec: { goal?: { condition: string; state: string } };
		};
		expect(widget?.type).toBe("lifecycle");
		expect(widget?.spec.goal?.condition).toBe("`npm run check` exits 0");
		expect(widget?.spec.goal?.state).toBe("active");
	});

	it("refuses to replace an active goal, and names the route that works", async () => {
		const fake = await bootBoth();
		await toolOf(fake, "goal_set")("g3", { condition: "`npm run check` exits 0" });
		const second = await toolOf(fake, "goal_set")("g4", { condition: "`npm test` passes with 0 errors" });
		expect(second.isError).toBe(true);
		expect(second.content[0].text).toContain("already active");
		// The old message ended at "ask the user to run /goal clear", which is a
		// human round trip for something the user's own `/goal` does freely — and
		// the reported case was an agent whose condition named a commit that had
		// been superseded by its own follow-up commit.
		expect(second.content[0].text).toContain("replace: true");
	});

	// Revising a finish line is legitimate — work moves, and a condition written
	// at turn three can name a sha that no longer exists. It is also the shape of
	// grading yourself against something easier, so it is recorded, and it must
	// not buy a fresh budget.
	it("revises the active goal in place with replace:true, keeping the ledger", async () => {
		const fake = await bootBoth();
		await toolOf(fake, "goal_set")("g5", { condition: "CI green on 2a70cf78" });
		const before = fake.entries.filter((e) => (e.data as { kind?: string })?.kind === "goal").pop()!
			.data as { id: string; ledger: { maxIterations: number } };

		const revised = await toolOf(fake, "goal_set")("g6", {
			condition: "CI green on 91943264",
			replace: true,
		});

		expect(revised.isError).toBeUndefined();
		expect(revised.content[0].text).toContain("Goal revised");
		expect(revised.content[0].text).toContain("CI green on 2a70cf78");

		const after = fake.entries.filter((e) => (e.data as { kind?: string })?.kind === "goal").pop()!.data as {
			id: string;
			condition: string;
			ledger: { maxIterations: number };
			revisions?: { from: string }[];
		};
		expect(after.condition).toBe("CI green on 91943264");
		// SAME goal, not a new one: a fresh goal would reset the caps.
		expect(after.id).toBe(before.id);
		expect(after.ledger.maxIterations).toBe(before.ledger.maxIterations);
		expect(after.revisions?.map((r) => r.from)).toEqual(["CI green on 2a70cf78"]);
	});

	it("still refuses an unverifiable revision", async () => {
		const fake = await bootBoth();
		await toolOf(fake, "goal_set")("g7", { condition: "`npm run check` exits 0" });
		const bad = await toolOf(fake, "goal_set")("g8", { condition: "make it nicer", replace: true });
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toContain("machine-checkable");
	});
});
