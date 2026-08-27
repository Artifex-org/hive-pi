/**
 * The plan gate is a STOP, not a notice.
 *
 * Reported from the workspace: an agent presented a plan, no approval card
 * appeared, and it began implementing while the card still read `ready`. Both
 * halves came from one branch. A Hive-launched agent runs `pi --op-mode build`,
 * so plan mode is not active; `plan_ready` therefore took the "no approval gate
 * to open — go ahead and execute it" path, which is right about the MODE and
 * wrong about the intent, and whose text is not the line the card is
 * discriminated on (`web/src/lib/planReady.ts`).
 *
 * These pin the three properties that make it a gate: it PARKS the turn, it
 * DENIES writes while parked, and elapsing releases neither.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import planExtension from "../extensions/plan/index.ts";
import { PLAN_CONTROL_CHANNEL, QUESTION_REMOTE_CHANNEL } from "../extensions/hive-common/channels.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

const originalHiveLaunchId = process.env.HIVE_LAUNCH_ID;

beforeEach(() => {
	process.env.HIVE_LAUNCH_ID = "11111111-2222-3333-4444-555555555555";
});

afterEach(() => {
	vi.useRealTimers();
	if (originalHiveLaunchId === undefined) delete process.env.HIVE_LAUNCH_ID;
	else process.env.HIVE_LAUNCH_ID = originalHiveLaunchId;
});

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
		ui: {
			confirm: async () => true,
			select: async () => undefined,
			notify: () => {},
			setWidget: () => {},
			setStatus: () => {},
		},
		sessionManager: { getEntries: () => [], getBranch: () => [] },
	} as unknown as ExtensionContext;
}

const PLAN_OPS = {
	ops: [
		{ op: "header", title: "Ship the gate", goal: "Approval stops the agent." },
		{
			op: "upsert",
			id: "steps",
			block: { type: "steps", steps: [{ title: "wire it" }, { title: "pin it" }] },
		},
	],
};

/** A launched agent: build mode (never `/plan`), with a browser attached. */
async function bootLaunched(attached = true): Promise<{ fake: FakePi; ctx: ExtensionContext }> {
	const fake = createFakePi();
	planExtension(fake.api);
	await fake.emit({ type: "session_start", reason: "new" });
	if (attached) fake.api.events.emit(QUESTION_REMOTE_CHANNEL, { available: true });
	const ctx = toolCtx();
	await toolOf(fake, "plan_write")("w1", PLAN_OPS, undefined, undefined, ctx);
	return { fake, ctx };
}

async function writeIsBlocked(fake: FakePi): Promise<boolean> {
	const [verdict] = await fake.emit({ type: "tool_call", toolName: "edit", input: {} });
	return (verdict as { block?: boolean } | undefined)?.block === true;
}

describe("a presented plan in a launched (build-mode) session", () => {
	it("parks the turn and denies writes until someone decides", async () => {
		const { fake, ctx } = await bootLaunched();

		const pending = toolOf(fake, "plan_ready")("r1", {}, undefined, undefined, ctx);
		// Give the tool a tick to raise the gate before probing it.
		await Promise.resolve();

		expect(await writeIsBlocked(fake)).toBe(true);

		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "approve" });
		const result = await pending;

		// The card's discriminator is the first line — without it the workspace
		// draws no approval card at all, which is half the reported bug.
		expect(result.content[0].text.startsWith("Plan is ready and awaiting approval")).toBe(true);
		expect(result.content[0].text).toContain("Approved");
		expect(await writeIsBlocked(fake)).toBe(false);
	});

	it("hands the decline back as the grill kick, and stays read-only", async () => {
		const { fake, ctx } = await bootLaunched();
		const pending = toolOf(fake, "plan_ready")("r1", {}, undefined, undefined, ctx);
		await Promise.resolve();

		fake.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "grill" });
		const result = await pending;

		expect(result.content[0].text).toContain("GRILLED");
		// A decline that handed the write tools back would be an approval with
		// extra steps — the same rule the grill stage already holds.
		expect(await writeIsBlocked(fake)).toBe(true);
	});

	// The point of the whole change: waiting is bounded, PERMISSION is not
	// granted by the wait elapsing. A turn held forever is HIV-1449; a gate that
	// opens itself is the bug being fixed.
	it("stops waiting after the budget but keeps the gate shut", async () => {
		vi.useFakeTimers();
		const { fake, ctx } = await bootLaunched();

		const pending = toolOf(fake, "plan_ready")("r1", {}, undefined, undefined, ctx);
		await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
		const result = await pending;

		expect(result.content[0].text).toContain("WRITES STAY DENIED");
		expect(await writeIsBlocked(fake)).toBe(true);
	});
});

describe("a session with nowhere for a decision to come from", () => {
	// `remoteAnswersAvailable` is hive-remote reporting a live attach. Without
	// one there is no card and no clicker, so a gate would be a wedge — the
	// failure plan_ask already documents. Behaviour must be exactly as before.
	it("presents the plan without parking, and does not deny writes", async () => {
		const { fake, ctx } = await bootLaunched(false);

		const result = await toolOf(fake, "plan_ready")("r1", {}, undefined, undefined, ctx);

		expect(result.content[0].text).toContain("Not in plan mode");
		expect(await writeIsBlocked(fake)).toBe(false);
	});
});

// The typed verb and the browser button are the same decision arriving by
// different doors. A gate only one of them could open would leave an operator
// typing `/plan approve` at a session that went on waiting.
describe("the typed verbs release a parked plan too", () => {
	it("`/plan approve` ends the wait and lifts the gate", async () => {
		const { fake, ctx } = await bootLaunched();
		const pending = toolOf(fake, "plan_ready")("r1", {}, undefined, undefined, ctx);
		await Promise.resolve();

		await fake.runCommand("plan", "approve");
		const result = await pending;

		expect(result.content[0].text).toContain("Approved");
		expect(await writeIsBlocked(fake)).toBe(false);
	});
});
