/**
 * The stages nothing but the machine can know, created WHEN THEY ARE ENTERED.
 *
 * This file used to seed. Every workflow opened with six boxes —
 * frame/plan/execute/verify/deliver/consolidate — and a five-step delivery lane
 * inside the fifth, on the reasoning that the push/PR/CI/review/merge sequence is
 * the most repeated structure in the fleet and the least interesting thing for a
 * model to author. That reasoning was right about coding sessions and wrong about
 * sessions.
 *
 * WHAT SEEDING COST. A session that orchestrates other agents, investigates an
 * incident, or sweeps a research question has no branch and will never open a
 * PR. It got the lane anyway, five steps deep, permanently pending — and because
 * the delivery lane is deliberately exempt from the conductor's sweeps (so that
 * "waiting on a gate" is reachable), a finished research run reported itself
 * forever as blocked on a merge that was never going to happen. The diagram said
 * the same thing: four empty boxes and a lane, before the agent had done
 * anything, on every session including the ones that were two messages long.
 *
 * WHAT REPLACES IT. Nothing appears until something enters it:
 *
 *   the conductor  creates the lifecycle stage it is walking INTO, one at a
 *                  time. A session that never leaves `execute` has one stage,
 *                  which is the truth about that session.
 *   the task list  creates the execute stage it mirrors into, if the conductor
 *                  has not already.
 *   the model      authors everything task-specific through `workflow_write`,
 *                  and can now put it in the right PLACE (`before`) rather than
 *                  only at the end.
 *
 * THE DELIVERY VOCABULARY SURVIVES. `DELIVERY_STEPS` is still exported and Hive
 * still resolves those kinds from its own run and pull rows wherever they appear
 * — a step declared `ci.green` gets its status from the gate whether the model
 * authored it or this file did. What is gone is the ASSUMPTION that every
 * session has one. A session that is shipping code declares the lane and gets
 * the same free resolution it always did; `deliveryLaneOps` builds it so that it
 * comes out identical every time, which was the half of seeding worth keeping.
 */

import { stageAnchor, type WorkflowDoc, type WorkflowOp, type WorkflowStage } from "./state.ts";

/**
 * The conductor's stages, in its order.
 *
 * `idle` and `done` are omitted: they are machine states rather than work, and a
 * lane that opened with an empty box called "idle" would read as a stage nobody
 * had got to yet.
 *
 * The order still matters even though nothing seeds it — it is what places a
 * lazily-created stage CORRECTLY. A conductor that goes straight to `execute`
 * and later reports `verify` must not append verify after a delivery lane the
 * agent added in between.
 */
export const LIFECYCLE_STAGES: readonly { kind: string; title: string }[] = [
	{ kind: "frame", title: "Frame" },
	{ kind: "plan", title: "Plan" },
	{ kind: "execute", title: "Execute" },
	{ kind: "verify", title: "Verify" },
	{ kind: "consolidate", title: "Consolidate" },
];

/**
 * The delivery lane. Order is the dependency: each waits on the one before.
 *
 * `ci.red` is deliberately absent. A workflow that pre-declares a red gate as a
 * step reads as though failing were the plan; an agent that ends up fixing one
 * can add that step itself, which is what `workflow_write` is for.
 */
export const DELIVERY_STEPS: readonly { kind: string; title: string }[] = [
	{ kind: "push", title: "Push the branch" },
	{ kind: "pr.open", title: "Open the pull request" },
	{ kind: "ci.green", title: "CI green" },
	{ kind: "review", title: "Reviewed" },
	{ kind: "merged", title: "Merged" },
];

export const DELIVER_STAGE_KIND = "deliver";
export const CONSOLIDATE_STAGE_KIND = "consolidate";

/**
 * Lane templates — the shapes a session can ASK for, never the ones it is given.
 *
 * Seeding is gone and is not coming back: it assumed every session ships code,
 * and an orchestration run, an infra audit and a research sweep each got a PR
 * lane they would never walk. What was worth keeping about it is narrower — that
 * for a handful of recognisable session shapes, the lane is the same every time
 * and is the least interesting thing for a model to author from scratch. So the
 * shapes live here and the model asks for one when it recognises its own work.
 *
 * The rule that makes these worth having rather than merely convenient:
 * **`after` is only set where the order is real.** A template that chained every
 * step would teach the diagram to draw a queue, and the whole point of the audit
 * and research lanes is that their middle is a genuine fan-out — four ways of
 * looking that do not wait on each other and are drawn side by side. Getting
 * this wrong in a template is worse than in a hand-written lane, because it is
 * wrong the same way in every session that asks for it.
 *
 * `machine: true` means Hive drives the lane's steps and the todo mirror must
 * not target it — true of `delivery` and nothing else. The rest are the model's
 * own work, so they stay claimable and can receive the todo list.
 */
export interface LaneTemplate {
	kind: string;
	title: string;
	/** Hive-driven: exempt from the conductor's sweeps, never a mirror target. */
	machine?: boolean;
	summary: string;
	steps: readonly { key: string; title: string; kind?: string; after?: readonly string[] }[];
	/** Optional body annotation for an iterating lane; never dependency edges. */
	loop?: { steps: readonly string[]; until?: string };
}

export const LANE_TEMPLATES: Readonly<Record<string, LaneTemplate>> = {
	delivery: {
		kind: DELIVER_STAGE_KIND,
		title: "Deliver",
		machine: true,
		summary: "push → PR → CI → review → merge, whose statuses Hive resolves itself",
		// A genuine sequence, and the only template that is one.
		steps: DELIVERY_STEPS.map((s, i) => ({
			key: s.kind.replace(".", "-"),
			title: s.title,
			kind: s.kind,
			after: i === 0 ? undefined : [DELIVERY_STEPS[i - 1].kind.replace(".", "-")],
		})),
	},

	orchestration: {
		kind: "orchestrate",
		title: "Orchestrate",
		summary: "split, launch subagents, supervise and resize, reconcile, synthesise",
		steps: [
			{ key: "split", title: "Decide the independent items and non-overlap boundaries" },
			// `launch` is the anchor a fan-out hangs from: one sub-step per
			// in-agent worker, via `parentId`, added as each one starts. This is
			// deliberately NOT Hive's workstation teammate layer.
			{ key: "launch", title: "Launch a bounded subagent wave (one sub-step each)", after: ["split"] },
			// Supervision, resizing and collection coexist while a durable wave is
			// live. Chaining them would claim the parent stops watching as soon as
			// the first result arrives.
			{ key: "supervise", title: "Inspect reports; follow up or steer wrong premises", after: ["launch"] },
			{ key: "resize", title: "Add a wave or stop redundant workers as gaps change", after: ["launch"] },
			{ key: "collect", title: "Collect every completed or stopped worker result", after: ["launch"] },
			{ key: "reconcile", title: "Run one reconciliation worker across all findings", after: ["collect"] },
			{ key: "synthesise", title: "Verify the reconciliation and synthesise", after: ["reconcile"] },
		],
		loop: {
			steps: ["launch", "supervise", "resize", "collect"],
			until: "coverage is complete and every live worker is collected or intentionally stopped",
		},
	},

	audit: {
		kind: "audit",
		title: "Audit",
		summary: "scope, then four independent sweeps, then rank and report",
		steps: [
			{ key: "scope", title: "Scope the surface and say what is out of scope" },
			// THE FAN-OUT. Four ways of looking, none waiting on another — this is
			// the shape the diagram exists to show, and the reason an audit lane is
			// worth templating at all.
			{ key: "inventory", title: "Inventory what actually exists", after: ["scope"] },
			{ key: "config", title: "Check configuration against intent", after: ["scope"] },
			{ key: "access", title: "Review access, secrets and rotation", after: ["scope"] },
			{ key: "signals", title: "Check logs, alerts and what is unmonitored", after: ["scope"] },
			{
				key: "rank",
				title: "Rank findings by blast radius, not by tidiness",
				after: ["inventory", "config", "access", "signals"],
			},
			{ key: "report", title: "Report, with the residual risk named", after: ["rank"] },
		],
	},

	incident: {
		kind: "incident",
		title: "Incident",
		summary: "impact first, then mitigate and diagnose in parallel, then fix and write it up",
		steps: [
			{ key: "impact", title: "Establish impact and blast radius" },
			// Deliberately parallel: waiting for a root cause before mitigating is
			// the classic incident mistake, and a chained template would encode it.
			{ key: "mitigate", title: "Stop the bleeding", after: ["impact"] },
			{ key: "diagnose", title: "Find the cause", after: ["impact"] },
			{ key: "fix", title: "Apply the real fix", after: ["diagnose"] },
			{ key: "writeup", title: "Write it up while it is still fresh", after: ["fix", "mitigate"] },
		],
	},

	research: {
		kind: "research",
		title: "Research",
		summary: "frame the question, sweep several ways at once, synthesise, record",
		steps: [
			{ key: "frame", title: "Frame the question and what would answer it" },
			{ key: "kb", title: "Search the knowledge base", after: ["frame"] },
			{ key: "code", title: "Search the code and its history", after: ["frame"] },
			{ key: "external", title: "Search outside", after: ["frame"] },
			{ key: "synthesise", title: "Synthesise, naming what is still unknown", after: ["kb", "code", "external"] },
			{ key: "record", title: "Record it where it will be found again", after: ["synthesise"] },
		],
	},

	review: {
		kind: "review",
		title: "Review",
		summary: "scope the change, read it several ways at once, then verify what you found",
		steps: [
			{ key: "scope", title: "Read the change and say what it is trying to do" },
			// Four readings of the same diff, and they are genuinely independent
			// — a security reading does not wait on a correctness one. Chaining
			// them would also imply an order of importance the reviewer has not
			// earned yet.
			{ key: "correctness", title: "Does it do that, on the paths it claims", after: ["scope"] },
			{ key: "failure", title: "What happens on the paths it does not claim", after: ["scope"] },
			{ key: "tests", title: "Would the tests fail if it were wrong", after: ["scope"] },
			{ key: "fit", title: "Does it match how this repo already does it", after: ["scope"] },
			// The step that makes a review worth reading: a finding you have not
			// tried to disprove is a guess with a file and a line number on it.
			{
				key: "verify",
				title: "Try to disprove each finding before reporting it",
				after: ["correctness", "failure", "tests", "fit"],
			},
			{ key: "report", title: "Report what survived, worst first", after: ["verify"] },
		],
	},

	fix: {
		kind: "fix",
		title: "Fix",
		summary: "reproduce, diagnose, fix, then prove it with the check that failed",
		// A genuine chain, and the ORDER is the content. Fixing before you can
		// reproduce is guessing, and a fix proved by anything other than the
		// check that failed is a fix you have not proved.
		steps: [
			{ key: "reproduce", title: "Reproduce it, and say exactly how" },
			{ key: "diagnose", title: "Find the cause, not the symptom", after: ["reproduce"] },
			{ key: "fix", title: "Fix the cause", after: ["diagnose"] },
			{ key: "prove", title: "Re-run the check that failed, and report what it said", after: ["fix"] },
		],
	},

	bugfix: {
		kind: "bugfix",
		title: "Bugfix protocol",
		summary: "reproduce, hypothesise, instrument, confirm, fix, then re-verify the same reproduction",
		steps: [
			{ key: "reproduce", title: "Create and run a reproducible failing case" },
			{ key: "hypothesis", title: "State a falsifiable root-cause hypothesis", after: ["reproduce"] },
			{ key: "instrument", title: "Instrument the behavior that distinguishes it", after: ["hypothesis"] },
			{ key: "confirm", title: "Confirm the mechanism with observed evidence", after: ["instrument"] },
			{ key: "fix", title: "Fix the confirmed root cause", after: ["confirm"] },
			{ key: "reverify", title: "Re-run the original reproduction and record its pass", after: ["fix"] },
		],
	},

	migration: {
		kind: "migrate",
		title: "Migrate",
		summary: "find every site, change them, then prove nothing else moved",
		steps: [
			// Discovery is its own step because the count is the thing everyone
			// gets wrong, and a sweep that starts before it finishes silently
			// defines "every" as "the ones I had found by then".
			{ key: "discover", title: "Find every site, and say how you know the list is complete" },
			{ key: "pattern", title: "Do one site end to end and let it set the pattern", after: ["discover"] },
			{ key: "sweep", title: "Apply it to the rest", after: ["pattern"] },
			// Two different questions, asked of the finished sweep: did the
			// changed sites work, and did the unchanged ones stay unchanged.
			{ key: "verify", title: "Prove the changed sites work", after: ["sweep"] },
			{ key: "residue", title: "Search again for sites the first pass missed", after: ["sweep"] },
		],
	},
};

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
