/**
 * The workflow document's op builders — DATA-FREE since HIV-2904.
 *
 * `LANE_TEMPLATES`, `LIFECYCLE_STAGES` and `DELIVERY_STEPS` moved to
 * `../plan/templates.ts` when the three work stores merged into the plan
 * document. They are re-exported from here rather than copied: two copies of a
 * table this opinionated would drift, and the drift would be invisible because
 * each copy looks right on its own.
 *
 * What stays is the half that is typed against `WorkflowDoc` — the builders the
 * workflow extension still calls while it is being reduced to a façade over the
 * plan document. When that extension goes, so does this file.
 */

import { LANE_TEMPLATES, LIFECYCLE_STAGES, DELIVERY_STEPS, DELIVER_STAGE_KIND, CONSOLIDATE_STAGE_KIND, type LaneTemplate } from "../plan/templates.ts";
import { stageAnchor, type WorkflowDoc, type WorkflowOp, type WorkflowStage } from "./state.ts";

export { LANE_TEMPLATES, LIFECYCLE_STAGES, DELIVERY_STEPS, DELIVER_STAGE_KIND, CONSOLIDATE_STAGE_KIND };
export type { LaneTemplate };

export const TEMPLATE_NAMES = Object.keys(LANE_TEMPLATES);

/**
 * The ops that build a template lane — ONE batch, because ids now work.
 *
 * The delivery lane used to need three applies: create the stage, then name it
 * from the steps, then chain the steps once their generated ids existed. Since a
 * caller-supplied id CREATES, the whole lane can be written in one batch with
 * the template's own keys as ids and `dependsOn` as forward references, which
 * `applyOps` already permits for a document being written top-down.
 *
 * Returns an empty list when the lane is already there — asking twice is a
 * no-op rather than a second lane.
 */
export function templateLaneOps(doc: WorkflowDoc, name: string, title?: string): WorkflowOp[] {
	const template = LANE_TEMPLATES[name];
	if (!template) return [];
	if (doc.stages.some((s) => s.kind === template.kind)) return [];

	// Prefer the template's name as the stage id so its steps read `audit.scope`
	// rather than `s4.7`; fall back to a generated one if a stage already holds
	// it, since a supplied id that exists would PATCH that stage instead.
	const stageId = doc.stages.some((s) => s.id === name) ? undefined : name;
	const stepId = (key: string) => `${stageId ?? name}.${key}`;

	const ops: WorkflowOp[] = [
		{
			op: "stage",
			...(stageId ? { id: stageId } : {}),
			kind: template.kind,
			title: title ?? template.title,
			before: stageAnchor(doc, template.kind),
			...(template.machine ? { origin: "machine" as const } : {}),
		},
	];
	for (const step of template.steps) {
		ops.push({
			op: "step",
			...(stageId ? { stageId } : {}),
			id: stepId(step.key),
			title: step.title,
			...(step.kind ? { kind: step.kind } : {}),
			...(step.after ? { dependsOn: step.after.map(stepId) } : {}),
		});
	}
	if (template.loop) {
		ops.push({
			op: "loop",
			stage: template.kind,
			steps: template.loop.steps.map(stepId),
			...(template.loop.until ? { until: template.loop.until } : {}),
		});
	}
	return ops;
}

/**
 * Whether the conductor's walk drives this stage — the sweeps' membership test.
 *
 * Kept separate from the canonical ORDER, which now lives in `state.ts` because
 * the model's own stage ops need it too. Conflating the two once put `verify`
 * AFTER the delivery lane: the anchor search skipped `deliver` because it had no
 * rank, found nothing later to sit in front of, and appended. Order and
 * ownership are separate questions, so they stay separate lists.
 */
function conductorOwns(kind: string): boolean {
	return LIFECYCLE_STAGES.some((s) => s.kind === kind);
}




/**
 * The conductor stage the document should be showing as running.
 *
 * Returns the ops to get there, or an empty list when it is already right —
 * which matters because `applyOps` bumps the revision on any change, and a no-op
 * bump is a POST to Hive per conductor beat.
 *
 * CREATES the stage when it is missing, which is what replaced seeding. The
 * conductor is the authority on which stage it is in, so a stage it reports and
 * the document lacks is a stage that should exist — and creating it here is what
 * lets a document start empty without the lifecycle silently going unrecorded.
 *
 * A stage the walk has passed is marked `done` rather than left pending: the
 * conductor never revisits, so a stage behind the current one is finished
 * whether or not anything said so. Stages the conductor does not own are left
 * alone entirely — sweeping an agent-authored stage to `done` because the
 * machine moved past its position would be the document marking work complete
 * that nobody did.
 */
export function opsForStage(doc: WorkflowDoc, stageKind: string, now: number): WorkflowOp[] {
	const ops: WorkflowOp[] = [];
	void now;

	let index = doc.stages.findIndex((s) => s.kind === stageKind);
	if (index < 0) {
		const known = LIFECYCLE_STAGES.find((s) => s.kind === stageKind);
		if (!known) return [];
		ops.push({
			op: "stage",
			kind: stageKind,
			title: known.title,
			status: "running",
			before: stageAnchor(doc, stageKind),
			origin: "machine",
		});
		// Everything already in the document that the conductor owns and that
		// ranks BEFORE this one has been walked past.
		index = Number.MAX_SAFE_INTEGER;
	}

	doc.stages.forEach((stage, i) => {
		// The delivery lane is not part of the conductor's walk — its steps are
		// resolved from Hive — so the walk must not sweep it to `done`.
		if (stage.kind === DELIVER_STAGE_KIND) return;
		// Nor is anything the model authored. Position in the array is not
		// evidence about work the conductor knows nothing about.
		if (!conductorOwns(stage.kind)) return;
		const want = i < index ? "done" : i === index ? "running" : "pending";
		if (stage.status !== want) ops.push({ op: "stage", id: stage.id, kind: stage.kind, status: want });
	});

	return ops;
}

/**
 * Ops that close out the walk when the conductor reports `done`.
 *
 * Without this the LAST stage the conductor entered stays `running` forever,
 * because `done` is a machine state with no stage of its own. Measured on a full
 * walk: `… verify=done deliver=pending consolidate=running`, and it never moves
 * again. Two things break, and the second is the subtle one:
 *
 *   - the diagram shows a finished session spinning on Consolidate;
 *   - the current stage is "the first RUNNING one", so it reports `consolidate`
 *     permanently and **`deliver` becomes unreachable** — which is precisely the
 *     stage a roster wants to surface, because it is the one that means "this
 *     agent is finished and waiting on a gate".
 *
 * The DELIVERY lane is exempt, as everywhere else: its steps are resolved from
 * Hive's own runs, and sweeping the stage to `done` here would be the document
 * claiming a merge nobody observed. Leaving it pending is what lets it become
 * the current stage once the agent's own walk is complete — which is exactly
 * what it means.
 */
export function opsForWalkComplete(doc: WorkflowDoc): WorkflowOp[] {
	const ops: WorkflowOp[] = [];
	for (const stage of doc.stages) {
		if (stage.kind === DELIVER_STAGE_KIND) continue;
		if (stage.status === "done" || stage.status === "skipped") continue;
		// An active loop with an in-flight body step is intentionally iterating,
		// not a stranded lane for the conductor to close.
		if (stage.loop?.active && stage.loop.steps.some((id) => stage.steps.some((step) => step.id === id && step.status === "running"))) continue;
		ops.push({ op: "stage", id: stage.id, kind: stage.kind, status: "done" });
	}
	return ops;
}

/**
 * Ops that make the execute stage's steps mirror the tasks list.
 *
 * The todo list and the workflow's execute stage are the same information, and
 * asking the model to maintain both is asking for two lists that disagree. So
 * the model keeps writing todos exactly as it always has, and this mirrors them
 * — matched by `taskId`, so a reworded todo updates its step rather than growing
 * a second one.
 *
 * CREATES the execute stage when it is missing, for the same reason `opsForStage`
 * does: with nothing seeded, a session whose conductor never engaged (the
 * complexity heuristic declines simple work) would otherwise have todos and no
 * lane to mirror them into, and the mirror would silently do nothing forever.
 */
export function opsForTasks(
	doc: WorkflowDoc,
	tasks: readonly { id: string; subject: string; status: string }[],
	now: number,
): WorkflowOp[] {
	void now;
	const ops: WorkflowOp[] = [];
	const target = mirrorTarget(doc);
	if (!target) {
		if (tasks.length === 0) return [];
		ops.push({
			op: "stage",
			kind: "execute",
			title: "Execute",
			before: stageAnchor(doc, "execute"),
			// The lane most likely to be adopted: the mirror almost always gets
			// here on turn one, before the model has authored anything, and the
			// model's own "Implement" stage should land IN this one.
			origin: "machine",
		});
	}

	// Matched across EVERY stage, not just the target's.
	//
	// The target moves — to the lane the model says it is in, and again when a
	// stranded lane's steps are migrated below. A lookup scoped to one stage
	// would stop recognising a todo the moment its step lived somewhere else and
	// mirror a second copy of it on the next beat.
	const byTaskId = new Map(
		doc.stages
			.flatMap((s) => s.steps)
			.filter((s) => s.taskId)
			.map((s) => [s.taskId as string, s]),
	);

	for (const task of tasks) {
		const status = taskStatusToWorkflow(task.status);
		const existing = byTaskId.get(task.id);
		if (!existing) {
			// `stageId` may be undefined here only when the stage is being created
			// in this same batch, which `applyOps` tracks as the batch's last stage.
			ops.push({ op: "step", stageId: target?.id, title: task.subject, taskId: task.id, status });
			continue;
		}
		if (existing.title !== task.subject || existing.status !== status) {
			ops.push({ op: "step", id: existing.id, title: task.subject, status });
		}
	}

	ops.push(...retireStrandedLane(doc, target));

	// A todo the model DELETED leaves its step behind on purpose. The workflow is
	// a record of how the work went, and a step that quietly vanishes takes the
	// evidence that it ever existed with it.
	return ops;
}

/**
 * The stage the todo list belongs in.
 *
 * It used to be "the stage whose kind is literally `execute`", and that is the
 * assumption this function exists to remove. `kind` does two jobs — a loose
 * label to the model, the adoption and ranking key to this code — and the model
 * treats it as the first. Measured on a live session: it labelled its Triage,
 * Fix and Verification stages ALL `plan`, so nothing matched, the mirror kept
 * its own `execute` lane, and the diagram carried a fourth box restating the
 * same three phases in the mirror's words.
 *
 * So the target is now **the lane the model says it is in**. The rule is one
 * sentence — *the model's structure wins whenever it exists* — and it is written
 * as a branch rather than a chain of `??` because the chain got it wrong: an
 * "any execute-kind stage" clause sat above the model fallback and matched the
 * MACHINE's own lane, so a document whose model stages were all still `pending`
 * targeted the machine lane and the fold below never fired. Measured live on the
 * build that shipped it, against a session whose three stages were `pending` at
 * the moment the todos arrived — the ordinary case for a plan written before the
 * work starts, not an exotic one.
 *
 * Within the model's stages: the running one, else one it kinded `execute`, else
 * the first — work starts at the beginning.
 *
 * Conductor stages are skipped entirely because they keep `origin`: they are the
 * machine's record of the walk, not a claim about where work lives.
 */
function mirrorTarget(doc: WorkflowDoc): WorkflowStage | undefined {
	const claimed = doc.stages.filter((s) => !s.origin);
	if (claimed.length > 0) {
		return (
			claimed.find((s) => s.status === "running") ??
			claimed.find((s) => s.kind === "execute") ??
			claimed[0]
		);
	}
	// Nothing the model has claimed: the machine's own lane from an earlier beat,
	// or none at all and the caller makes one.
	return doc.stages.find((s) => s.kind === "execute");
}

/**
 * Ops that fold an orphaned mirror lane into the stage the todos now belong to.
 *
 * Without this the fix above only helps todos that arrive AFTER the model
 * authors its stages — and the mirror almost always gets there first, on turn
 * one, before the model has said anything. The lane it made then is left
 * holding the early todos while everything since goes elsewhere, which is the
 * same fourth box arriving a different way.
 *
 * Deliberately narrow. It fires only for a lane the MACHINE made, that the
 * model never claimed, holding NOTHING but mirrored todos, when the todos now
 * belong to a lane the model authored. Any step without a `taskId` is somebody
 * writing into that lane on purpose, and the lane stays.
 */
function retireStrandedLane(doc: WorkflowDoc, target: WorkflowStage | undefined): WorkflowOp[] {
	if (!target || target.origin) return [];
	const stranded = doc.stages.find(
		(s) =>
			s.origin === "machine" &&
			s.id !== target.id &&
			s.steps.length > 0 &&
			s.steps.every((step) => step.taskId),
	);
	if (!stranded) return [];
	return [
		...stranded.steps.map((step) => ({ op: "moveStep" as const, id: step.id, stageId: target.id })),
		// Empty by the time this lands, so nothing is cascaded away with it.
		{ op: "removeStage" as const, id: stranded.id },
	];
}

function taskStatusToWorkflow(status: string): "pending" | "running" | "done" {
	if (status === "completed") return "done";
	if (status === "in_progress") return "running";
	return "pending";
}
