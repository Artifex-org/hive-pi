/**
 * What the plan extension actually WRITES — snapshots versus ticks.
 *
 * The two-clock split saves transcript by not re-emitting the whole document
 * when a checkbox moves (measured before the merge: 10.2 plan snapshots plus
 * 12.6 workflow snapshots per session, 34.7 MB across 594 sessions). The saving
 * is only safe if every reader can still reconstruct the document — and the
 * failure mode is silent, because a stale reader shows a plausible plan that is
 * merely out of date.
 *
 * So these tests assert the WRITE, not the in-memory state: which entry type
 * landed, and what a reader taking only snapshots would see.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import planExtension from "../extensions/plan/index.ts";
import { PLAN_ENTRY_TYPE, PLAN_TICK_ENTRY_TYPE, rehydratePlan } from "../extensions/plan/state.ts";
import { HIVE_PLAN_CHANNEL } from "../extensions/hive-common/channels.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

type ToolExecute = (
	id: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
	onUpdate?: unknown,
	ctx?: ExtensionContext,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function toolOf(fake: FakePi, name: string): ToolExecute {
	const tool = fake.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return (tool.definition as { execute: ToolExecute }).execute;
}

const toolCtx = (): ExtensionContext =>
	({ mode: "tui", cwd: "/tmp/fake-repo", hasUI: true, isIdle: () => true }) as unknown as ExtensionContext;

const typesOf = (fake: FakePi): string[] => fake.entries.map((entry) => entry.customType);

describe("plan persistence — snapshots and ticks", () => {
	let fake: FakePi;

	beforeEach(async () => {
		fake = createFakePi();
		planExtension(fake.api);
		await fake.emit({ type: "session_start", reason: "new" });
	});

	let call = 0;
	const write = (ops: unknown[]) => toolOf(fake, "plan_write")(`t${call++}`, { ops }, undefined, undefined, toolCtx());

	it("writes a snapshot when the plan's meaning changes", async () => {
		await write([{ op: "lane", kind: "execute", items: [{ id: "a", title: "a" }] }]);
		expect(typesOf(fake).filter((t) => t === PLAN_ENTRY_TYPE)).not.toHaveLength(0);
		expect(typesOf(fake)).not.toContain(PLAN_TICK_ENTRY_TYPE);
	});

	it("writes only a tick when a checkbox moves", async () => {
		await write([{ op: "lane", kind: "execute", items: [{ id: "a", title: "a" }] }]);
		const snapshotsBefore = typesOf(fake).filter((t) => t === PLAN_ENTRY_TYPE).length;

		await write([{ op: "set_step", id: "a", status: "done" }]);

		expect(typesOf(fake).filter((t) => t === PLAN_ENTRY_TYPE)).toHaveLength(snapshotsBefore);
		expect(typesOf(fake)).toContain(PLAN_TICK_ENTRY_TYPE);
	});

	it("still lets a reader reconstruct the ticked document", async () => {
		await write([{ op: "lane", kind: "execute", items: [{ id: "a", title: "a" }] }]);
		await write([{ op: "set_step", id: "a", status: "done", note: "it was already done" }]);

		const folded = rehydratePlan(fake.entries as readonly unknown[]);
		const item = folded?.blocks.flatMap((b) => (b.type === "steps" ? b.steps : []))[0];
		expect(item).toMatchObject({ status: "done", note: "it was already done" });
	});

	it("ALWAYS writes a snapshot when the phase changes", async () => {
		// A phase change is a tick by the clock rule — it changes nothing about
		// what the plan means — but it is the approval machinery: `ready` is what
		// arms the operator's card. A reader that takes the newest SNAPSHOT would
		// carry a stale phase and show a plan that never asks to be approved.
		await write([{ op: "lane", kind: "execute", items: [{ id: "a", title: "a" }] }]);
		await write([{ op: "set_step", id: "a", status: "done" }]);
		const before = typesOf(fake).filter((t) => t === PLAN_ENTRY_TYPE).length;

		await write([{ op: "header", phase: "ready" }]);

		expect(typesOf(fake).filter((t) => t === PLAN_ENTRY_TYPE)).toHaveLength(before + 1);

		// The property that matters, stated as a reader would experience it: a
		// consumer that only ever reads snapshots sees the new phase.
		const snapshots = fake.entries.filter((entry) => entry.customType === PLAN_ENTRY_TYPE);
		const latest = rehydratePlan([snapshots[snapshots.length - 1]] as readonly unknown[]);
		expect(latest?.phase).toBe("ready");
	});

	it("bumps the doorbell's progress without bumping its revision", async () => {
		const rung: { revision: number; progress?: number }[] = [];
		fake.api.events.on(HIVE_PLAN_CHANNEL, (data: unknown) => rung.push(data as { revision: number; progress?: number }));

		await write([{ op: "lane", kind: "execute", items: [{ id: "a", title: "a" }] }]);
		await write([{ op: "set_step", id: "a", status: "done" }]);

		expect(rung).toHaveLength(2);
		expect(rung[1].revision).toBe(rung[0].revision);
		expect(rung[1].progress).toBe((rung[0].progress ?? 0) + 1);
	});
});
