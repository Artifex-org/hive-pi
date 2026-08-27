/**
 * What the `workflow` extension actually DOES when pi emits an event.
 *
 * `workflow-state.test.ts` covers the fold; this covers the wiring, which is
 * where the shipped bugs in this repo have always lived (see fake-pi.ts's
 * header). Four behaviours here can only fail at runtime:
 *
 *   - NOTHING IS SEEDED. The document starts empty and every stage in it got
 *     there because something entered it. The failure this replaces: a research
 *     or orchestration session acquiring a five-step delivery lane it would
 *     never walk, then reporting itself forever as blocked on a merge.
 *   - the NO-OP discipline. Every revision is a PUT to Hive, and both the
 *     conductor hook and the task mirror fire on beats that are usually no-ops.
 *   - the DOORBELL. It must carry a revision and nothing else; a payload here
 *     would put step titles and branch names on a process-local bus.
 *   - REHYDRATION. A workflow that empties on `/reload` would restart the
 *     lifecycle over work already half-delivered.
 */

import { beforeEach, describe, expect, it } from "vitest";

import workflow from "../extensions/workflow/index.ts";
import { CONDUCTOR_CHANNEL, HIVE_WORKFLOW_CHANNEL } from "../extensions/hive-common/channels.ts";
import { DECK_SECTION_CHANNEL } from "../extensions/deck/protocol.ts";
import {
	applyOps,
	emptyWorkflow,
	toEntry,
	validateSnapshot,
	WORKFLOW_ENTRY_TYPE,
} from "../extensions/workflow/state.ts";
import { opsForStage } from "../extensions/workflow/template.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

const NOW = 1_700_000_000_000;

let pi: FakePi;
beforeEach(() => {
	pi = createFakePi();
});

/**
 * A workflow already part-way through its walk, for the resume cases.
 *
 * Built the way a real one is now built — by walking the conductor through it,
 * which creates each stage on the way in — rather than from a template.
 */
function midflightWorkflow() {
	let doc = applyOps(emptyWorkflow(NOW), [{ op: "meta", title: "Already going" }], NOW).doc;
	for (const stage of ["frame", "plan", "execute"]) {
		doc = applyOps(doc, opsForStage(doc, stage, NOW), NOW).doc;
	}
	return doc;
}

/** The newest persisted document, validated back out of the entry. */
function stored(p: FakePi) {
	const entries = p.entries.filter((e) => e.customType === WORKFLOW_ENTRY_TYPE);
	if (entries.length === 0) return null;
	return validateSnapshot(entries[entries.length - 1].data);
}

const doorbells = (p: FakePi) => p.busEvents.filter((e) => e.name === HIVE_WORKFLOW_CHANNEL);

/** Invoke a registered tool the way pi does. Same shape as background-extension.test.ts. */
async function call(p: FakePi, name: string, params: unknown) {
	const tool = p.tools.find((t) => t.name === name);
	if (!tool) throw new Error(`no tool registered named "${name}"`);
	const execute = (tool.definition as { execute: (...args: unknown[]) => Promise<unknown> }).execute;
	return (await execute("call-id", params, undefined, undefined, undefined)) as {
		content: { text: string }[];
		details: Record<string, unknown>;
	};
}

describe("nothing is seeded", () => {
	it("writes NOTHING until something says this session is task-shaped", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		// A plain conversation must not acquire a delivery lane that then reads
		// as unfinished work forever.
		expect(stored(pi)).toBeNull();
		expect(doorbells(pi)).toHaveLength(0);
	});

	it("creates ONLY the stage the conductor entered", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "frame" });

		const doc = stored(pi);
		expect(doc).not.toBeNull();
		// One box, not six. The stages a session never enters are stages it never
		// had, and drawing them up front was a claim about work nobody had done.
		expect(doc!.stages.map((s) => s.kind)).toEqual(["frame"]);
	});

	it("gives a NON-shipping session no delivery lane at all", async () => {
		// The whole reason seeding went. An orchestration or infra session has no
		// branch; a permanently-pending push/PR/CI/review/merge lane on one is five
		// steps that will never happen, and `deliver` is exempt from the walk's
		// sweeps, so it reported blocked on a merge forever.
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await call(pi, "workflow_write", {
			ops: [
				{ op: "stage", title: "Investigate", kind: "research" },
				{ op: "step", title: "read the pod logs" },
			],
		});

		const doc = stored(pi)!;
		expect(doc.stages.map((s) => s.title)).toEqual(["Investigate"]);
		expect(doc.stages.some((s) => s.kind === "deliver")).toBe(false);
	});

	it("adds the delivery lane, chained, when the session ASKS for one", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await call(pi, "workflow_write", { ops: [{ op: "delivery" }] });

		const deliver = stored(pi)!.stages.find((s) => s.kind === "deliver")!;
		expect(deliver.steps.map((s) => s.kind)).toEqual([
			"push",
			"pr.open",
			"ci.green",
			"review",
			"merged",
		]);
		// Chained, which is what makes the lane read as a lane rather than five
		// parallel boxes.
		expect(deliver.steps[0].dependsOn).toBeUndefined();
		expect(deliver.steps[1].dependsOn).toEqual([deliver.steps[0].id]);
		expect(deliver.steps[4].dependsOn).toEqual([deliver.steps[3].id]);
	});

	it("refuses to add a SECOND delivery lane", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await call(pi, "workflow_write", { ops: [{ op: "delivery" }] });
		await call(pi, "workflow_write", { ops: [{ op: "delivery" }] });
		expect(stored(pi)!.stages.filter((s) => s.kind === "deliver")).toHaveLength(1);
	});
});

describe("the conductor drives the lifecycle, without the model", () => {
	it("advances the stage on a beat", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "frame" });
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "execute" });

		const doc = stored(pi)!;
		const byKind = new Map(doc.stages.map((s) => [s.kind, s.status]));
		expect(byKind.get("frame")).toBe("done");
		expect(byKind.get("execute")).toBe("running");
		// `verify` is not there YET — a stage exists once the walk enters it, and
		// not before. Drawing it as pending in advance was the seeding assumption
		// in miniature: a box for work that may never happen.
		expect(byKind.has("verify")).toBe(false);
		// `plan` was skipped entirely (the conductor jumped frame → execute), so it
		// never appears either.
		expect(doc.stages.map((s) => s.kind)).toEqual(["frame", "execute"]);
	});

	it("writes NOTHING for a repeated beat", async () => {
		// Every revision is a PUT to Hive; the conductor re-announces its stage
		// more often than it changes it.
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "execute" });
		const after = pi.entries.length;
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "execute" });
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "execute" });
		expect(pi.entries.length).toBe(after);
	});

	it("neither machine-only stage SEEDS a document", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		// `idle` is "has not started" and `done` is "everything finished";
		// neither is a box worth drawing, and a session that never had a
		// workflow does not acquire one by finishing.
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "idle" });
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "done" });
		expect(stored(pi)).toBeNull();
	});

	// `done` DOES close out an existing walk. Without it the last stage the
	// conductor entered stayed `running` forever — the diagram showed a finished
	// session spinning on Consolidate, and `deliver` could never become the
	// current stage, which is the one a roster actually wants to surface.
	it("closes out the walk on `done`, making DELIVER current", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		// This session IS shipping code, so it asks for the lane — which is now the
		// only way one exists.
		await call(pi, "workflow_write", { ops: [{ op: "delivery" }] });
		for (const stage of ["frame", "plan", "execute", "verify", "consolidate"]) {
			pi.api.events.emit(CONDUCTOR_CHANNEL, { stage });
		}
		expect(stored(pi)!.stages.find((s) => s.kind === "consolidate")?.status).toBe("running");

		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "done" });
		const after = stored(pi)!;
		expect(after.stages.filter((s) => s.status === "running")).toHaveLength(0);
		// And the delivery lane is NOT swept done — that would claim a merge
		// nobody observed.
		expect(after.stages.find((s) => s.kind === "deliver")?.status).toBe("pending");
	});

	it("writes nothing for a repeated `done`", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "execute" });
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "done" });
		const after = pi.entries.length;
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "done" });
		expect(pi.entries.length).toBe(after);
	});

	it("ignores a stage name it does not know", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: 42 });
		pi.api.events.emit(CONDUCTOR_CHANNEL, {});
		expect(stored(pi)).toBeNull();
	});
});

describe("the doorbell", () => {
	it("carries a revision and NOTHING else", async () => {
		// The document names branches, files and step titles, and this bus is
		// process-local — any loaded extension could subscribe to it. hive-remote
		// reads the document out of the session entries under its own consent.
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "frame" });

		const rung = doorbells(pi);
		expect(rung.length).toBeGreaterThan(0);
		for (const e of rung) {
			expect(Object.keys(e.payload as object)).toEqual(["revision"]);
			expect(typeof (e.payload as { revision: unknown }).revision).toBe("number");
		}
	});

	it("rings once per persisted revision, and its revision matches the document", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "frame" });
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "execute" });

		const rung = doorbells(pi);
		const written = pi.entries.filter((e) => e.customType === WORKFLOW_ENTRY_TYPE);
		expect(rung).toHaveLength(written.length);
		expect((rung[rung.length - 1].payload as { revision: number }).revision).toBe(
			stored(pi)!.revision,
		);
	});
});

describe("the task mirror", () => {
	const tasksEntry = (tasks: { id: string; subject: string; status: string }[]) => ({
		customType: "tasks",
		data: { kind: "tasks", schemaVersion: 1, tasks, nextId: tasks.length + 1 },
	});

	it("mirrors the todo list into the execute stage", async () => {
		workflow(pi.api);
		const branch = [
			tasksEntry([
				{ id: "1", subject: "read the code", status: "completed" },
				{ id: "2", subject: "write the fix", status: "in_progress" },
			]),
		];
		await pi.emit({ type: "session_start", reason: "startup" }, { branch });
		pi.api.events.emit(DECK_SECTION_CHANNEL, { section: "tasks" });

		const execute = stored(pi)!.stages.find((s) => s.kind === "execute")!;
		expect(execute.steps.map((s) => s.title)).toEqual(["read the code", "write the fix"]);
		expect(execute.steps[0].status).toBe("done");
		expect(execute.steps[1].status).toBe("running");
	});

	it("ignores a deck event for a different section", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		pi.api.events.emit(DECK_SECTION_CHANNEL, { section: "gate" });
		expect(stored(pi)).toBeNull();
	});

	it("writes NOTHING when the mirror is already current", async () => {
		workflow(pi.api);
		const branch = [tasksEntry([{ id: "1", subject: "read the code", status: "pending" }])];
		await pi.emit({ type: "session_start", reason: "startup" }, { branch });
		pi.api.events.emit(DECK_SECTION_CHANNEL, { section: "tasks" });
		const after = pi.entries.length;
		pi.api.events.emit(DECK_SECTION_CHANNEL, { section: "tasks" });
		expect(pi.entries.length).toBe(after);
	});
});

describe("the tool re-homes the todo list", () => {
	const tasksEntry = (tasks: { id: string; subject: string; status: string }[]) => ({
		customType: "tasks",
		data: { kind: "tasks", schemaVersion: 1, tasks, nextId: tasks.length + 1 },
	});

	/**
	 * The wiring bug three deployed builds shipped.
	 *
	 * `opsForTasks` decides WHERE the todos live, and it only ever ran on a
	 * task-list beat. But the thing that changes its answer is the MODEL
	 * authoring stages, and a session whose todo list does not change afterwards
	 * — most of them; the list is usually written once up front — never rang that
	 * bell again. So the mirror's lane sat beside the model's structure restating
	 * it, with the code that folds it away correct, deployed, and never called.
	 *
	 * Measured three times, on three builds, by running one session against each.
	 * No state test could see it: every one of them called `opsForTasks` by hand.
	 */
	it("folds its own lane away when the model authors structure, with no further task beat", async () => {
		workflow(pi.api);
		const branch = [
			tasksEntry([
				{ id: "1", subject: "Triage memory growth", status: "in_progress" },
				{ id: "2", subject: "Implement root-cause fix", status: "pending" },
			]),
		];
		await pi.emit({ type: "session_start", reason: "startup" }, { branch });
		pi.api.events.emit(DECK_SECTION_CHANNEL, { section: "tasks" });
		expect(stored(pi)!.stages.map((s) => s.title)).toEqual(["Execute"]);

		// The model authors its own structure. No deck event follows.
		await call(pi, "workflow_write", {
			ops: [
				{ op: "stage", id: "triage", kind: "investigation", title: "Triage growth", status: "running" },
				{ op: "step", id: "baseline", stageId: "triage", title: "Baseline and classify growth" },
				{ op: "stage", id: "fix", kind: "implementation", title: "Root-cause fix" },
				{ op: "step", id: "repair", stageId: "fix", title: "Fix the retention path" },
			],
		});

		const doc = stored(pi)!;
		expect(doc.stages.map((s) => s.title)).toEqual(["Triage growth", "Root-cause fix"]);
		expect(doc.stages[0].steps.map((s) => s.title)).toEqual([
			"Baseline and classify growth",
			"Triage memory growth",
			"Implement root-cause fix",
		]);
	});

	it("writes nothing extra when there is no todo list to re-home", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await call(pi, "workflow_write", { ops: [{ op: "stage", title: "Look", kind: "research" }] });
		const after = pi.entries.length;
		await call(pi, "workflow_write", { ops: [{ op: "meta", title: "Same" }] });
		// One entry for the meta change, and nothing from the re-mirror.
		expect(pi.entries.length).toBe(after + 1);
	});
});

describe("the tool", () => {
	it("REFUSES a status on an observed kind and tells the model why", async () => {
		// Hive resolves that step from its own runs and throws this value away.
		// A tool that silently ignored the argument would teach the model to keep
		// sending it forever.
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await call(pi, "workflow_write", { ops: [{ op: "stage", title: "Ship", kind: "ship" }] });
		const stageId = stored(pi)!.stages.find((s) => s.kind === "ship")!.id;

		const second = await call(pi, "workflow_write", {
			ops: [{ op: "step", stageId, title: "CI green", kind: "ci.green", status: "done" }],
		});

		expect(second.content[0].text).toMatch(/status ignored/i);
		const step = stored(pi)!
			.stages.find((s) => s.id === stageId)!
			.steps.find((s) => s.kind === "ci.green")!;
		expect(step.status).toBe("pending");
	});

	it("returns the whole document — the model has no other view of it", async () => {
		// A custom session entry is structurally invisible to the LLM and this
		// repo bans the `context` handler that would inject one.
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		const result = await call(pi, "workflow_write", {
			ops: [{ op: "meta", title: "Ship the graph" }, { op: "delivery" }],
		});

		expect(result.content[0].text).toContain("Ship the graph");
		expect(result.content[0].text).toContain("Deliver");
		// And it marks the steps whose status is not the agent's to set.
		expect(result.content[0].text).toMatch(/resolved by Hive/);
		expect(result.details.stages).toBeGreaterThan(0);
	});
});

describe("session_start", () => {
	it("RESTORES a workflow on reload rather than seeding a second one", async () => {
		// A workflow that empties on `/reload` would re-seed a fresh delivery
		// lane over work already half-delivered, and restart the lifecycle at
		// `frame`.
		const existing = midflightWorkflow();
		workflow(pi.api);
		await pi.emit(
			{ type: "session_start", reason: "reload" },
			{ branch: [{ customType: WORKFLOW_ENTRY_TYPE, data: toEntry(existing) }] },
		);
		// Nothing written: it already had one.
		expect(pi.entries.filter((e) => e.customType === WORKFLOW_ENTRY_TYPE)).toHaveLength(0);

		// And the restored stage survives rather than restarting at frame.
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "verify" });
		const byKind = new Map(stored(pi)!.stages.map((s) => [s.kind, s.status]));
		expect(byKind.get("verify")).toBe("running");
		expect(byKind.get("execute")).toBe("done");
	});

	it("starts a FRESH session empty, whatever the previous one held", async () => {
		const existing = midflightWorkflow();
		workflow(pi.api);
		await pi.emit(
			{ type: "session_start", reason: "new" },
			{ branch: [{ customType: WORKFLOW_ENTRY_TYPE, data: toEntry(existing) }] },
		);
		expect(stored(pi)).toBeNull();
	});

	it("survives a session whose entries cannot be read", async () => {
		workflow(pi.api);
		// Deliberately not the branch type: this is what a session whose entries
		// are junk actually looks like, and the cast is the honest way to say so.
		const junk = [null, 7, "nonsense"] as unknown as NonNullable<
			Parameters<typeof pi.emit>[1]
		>["branch"];
		await pi.emit({ type: "session_start", reason: "reload" }, { branch: junk });
		expect(stored(pi)).toBeNull();
		// And still works afterwards.
		pi.api.events.emit(CONDUCTOR_CHANNEL, { stage: "frame" });
		expect(stored(pi)).not.toBeNull();
	});
});

// Guards the "nothing mutable at module scope" constraint: pi builds a fresh
// jiti per extension entry with moduleCache:false, so two factories must not
// share a document.
describe("two instances are independent", () => {
	it("does not leak a document between factories", async () => {
		const a = createFakePi();
		const b = createFakePi();
		workflow(a.api);
		workflow(b.api);
		await a.emit({ type: "session_start", reason: "startup" });
		await b.emit({ type: "session_start", reason: "startup" });
		a.api.events.emit(CONDUCTOR_CHANNEL, { stage: "frame" });

		expect(stored(a)).not.toBeNull();
		expect(stored(b)).toBeNull();
	});
});


// `plan_write` patches a step with `{op:"set_step"}`; this tool's own spelling is
// `{op:"step"}`. The two sit side by side in one session, and five agents in two
// days (2026-08-17/18) sent the plan spelling here — getting `ops.0.op: must be
// equal to constant`, which names neither an accepted value nor the other tool.
// The batch was refused, so the workflow simply stopped being updated while the
// session carried on working.
describe("the plan-side spelling", () => {
	it("applies a set_step patch instead of refusing the batch", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await call(pi, "workflow_write", {
			ops: [
				{ op: "stage", id: "s1", title: "Investigate", kind: "research" },
				{ op: "step", id: "one", stageId: "s1", title: "read the pod logs" },
			],
		});

		const res = await call(pi, "workflow_write", {
			ops: [{ op: "set_step", id: "one", status: "done", note: "it was the sidecar" }],
		});

		const step = stored(pi)!.stages.flatMap((s) => s.steps).find((s) => s.id === "one")!;
		expect(step.status).toBe("done");
		expect(step.note).toBe("it was the sidecar");
		// And it says which spelling this tool uses, once, so the next call is right.
		expect(res.content[0].text).toContain("set_step");
		expect(res.content[0].text).toContain("step");
	});

	it("takes set_stage the same way", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await call(pi, "workflow_write", { ops: [{ op: "set_stage", id: "s1", title: "Triage" }] });

		expect(stored(pi)!.stages.map((s) => s.title)).toEqual(["Triage"]);
	});

	it("says nothing extra when the caller used this tool's own spelling", async () => {
		workflow(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		const res = await call(pi, "workflow_write", {
			ops: [{ op: "stage", title: "Investigate", kind: "research" }],
		});

		expect(res.content[0].text).not.toContain("set_step");
		expect(res.content[0].text).not.toContain("plan_write");
	});
});
