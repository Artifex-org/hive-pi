#!/usr/bin/env node
/**
 * plan-shape — what the plan, tasks and workflow extensions produce TOGETHER,
 * measured against real sessions rather than against their own tests.
 *
 * WHY THIS EXISTS. HIV-2902 merges the three into one document. The argument
 * for doing it is a set of numbers: how often one piece of work is held in two
 * or three stores at once, what a plan is actually made of (the suspected base
 * rate is prose plus a checklist), and what two separate documents cost the
 * transcript in whole-document re-snapshots. This is the instrument that takes
 * those numbers before the merge and again after, so the change is judged by
 * what reaches the reader and not by what the tests permit.
 * `workflow-shape.mjs` is the narrower sibling for the workflow document's own
 * defects; this one is about the seams between the three.
 *
 * USAGE
 *   node scripts/plan-shape.mjs [--since '2026-07-28'] [--json] [--include-probes]
 *
 * Reads pi's own transcripts (`~/.pi/agent/sessions/<slug>/*.jsonl`) — local,
 * already on disk, no Hive call. `--since` is when the session STARTED (see
 * lib/transcripts.mjs for why that and not mtime).
 *
 * READING THE OUTPUT.
 *
 * "Stores" are the three session entry types — `plan`, `tasks`, `workflow` —
 * each of which the extensions write as a WHOLE-document snapshot on every
 * mutation, a step tick included. `snapshots` and `KB` per session are
 * therefore what the transcript pays per tick today, and the number the
 * `plan.tick` entry of HIV-2902 has to beat. A session "holds" a store when
 * the final snapshot has content (≥1 block, ≥1 task, ≥1 stage); a store that
 * was written and later emptied does not count.
 *
 * "Same work in more than one store" is measured by the id links the
 * extensions themselves write, never by matching titles: a workflow step with
 * `taskId` is a todo mirrored into the workflow; a plan step with `taskId` is a
 * plan step that became a todo on approval; a workflow step carrying both
 * `taskId` and `planStepId` is one item held three times.
 *
 * "Prose + checklist only" is a plan whose block types are a subset of
 * {text, steps} — the composition the lint in HIV-2902 P4 exists to move.
 */

import { readFileSync } from "node:fs";

import { parseArgs, SESSIONS, transcripts } from "./lib/transcripts.mjs";

/** The closed catalog, in the order the prompt teaches it. Unknown types are kept and reported. */
const BLOCK_TYPES = ["text", "steps", "chart", "diagram", "refs", "table", "metrics", "callout", "code", "artifact"];

/** A cheap substring guard so megabyte transcripts are not JSON-parsed line by line. */
const INTERESTING = /plan|tasks|workflow|Todo|Task/;

function toolInput(block) {
	// Providers disagree about the field name, and one of them ships it as a
	// JSON string. Getting this wrong reads as "the tool was never used".
	let input = block.input ?? block.arguments ?? {};
	if (typeof input === "string") {
		try {
			input = JSON.parse(input);
		} catch {
			input = {};
		}
	}
	return input;
}

function bump(map, key) {
	map[key] = (map[key] ?? 0) + 1;
}

/**
 * The final snapshot of each store, the snapshot cost, and every relevant tool
 * call in one transcript. Returns null when the session touched none of them.
 */
function readSession(path) {
	const s = {
		plan: null,
		tasks: null,
		workflow: null,
		snapshots: { plan: 0, tasks: 0, workflow: 0 },
		bytes: { plan: 0, tasks: 0, workflow: 0 },
		calls: { plan_write: 0, plan_ready: 0, plan_ask: 0, todo: 0, workflow_write: 0 },
		planOps: {},
		upsertTypes: {},
	};
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	for (const line of text.split("\n")) {
		if (!INTERESTING.test(line)) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.customType === "plan") {
			s.plan = entry.data?.doc ?? s.plan;
			s.snapshots.plan++;
			s.bytes.plan += line.length;
			continue;
		}
		if (entry.customType === "tasks") {
			if (Array.isArray(entry.data?.tasks)) s.tasks = entry.data.tasks;
			s.snapshots.tasks++;
			s.bytes.tasks += line.length;
			continue;
		}
		if (entry.customType === "workflow") {
			s.workflow = entry.data?.doc ?? s.workflow;
			s.snapshots.workflow++;
			s.bytes.workflow += line.length;
			continue;
		}
		for (const block of entry.message?.content ?? []) {
			const name = block?.name;
			if (typeof name !== "string") continue;
			if (name === "plan_write") {
				s.calls.plan_write++;
				const input = toolInput(block);
				for (const op of Array.isArray(input.ops) ? input.ops : []) {
					if (typeof op?.op !== "string") continue;
					bump(s.planOps, op.op);
					const type = op.block?.type ?? op.type;
					if (op.op === "upsert" && typeof type === "string") bump(s.upsertTypes, type);
				}
			} else if (name === "plan_ready") s.calls.plan_ready++;
			else if (name === "plan_ask") s.calls.plan_ask++;
			else if (name === "TodoWrite" || name === "TaskCreate" || name === "TaskUpdate") s.calls.todo++;
			else if (name === "workflow_write") s.calls.workflow_write++;
		}
	}
	const touched = s.plan || s.tasks || s.workflow || Object.values(s.calls).some((n) => n > 0);
	return touched ? s : null;
}

function measure(s) {
	const blocks = Array.isArray(s.plan?.blocks) ? s.plan.blocks : [];
	const tasks = Array.isArray(s.tasks) ? s.tasks : [];
	const stages = Array.isArray(s.workflow?.stages) ? s.workflow.stages : [];
	const wfSteps = stages.flatMap((st) => (Array.isArray(st.steps) ? st.steps : []));
	const planSteps = blocks.filter((b) => b.type === "steps").flatMap((b) => (Array.isArray(b.steps) ? b.steps : []));

	const blockTypes = {};
	for (const b of blocks) bump(blockTypes, typeof b.type === "string" ? b.type : "?");

	const kinds = stages.map((st) => st.kind);
	const seen = new Map();
	for (const k of kinds) seen.set(k, (seen.get(k) ?? 0) + 1);
	const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);

	const stores = [];
	if (blocks.length > 0) stores.push("plan");
	if (tasks.length > 0) stores.push("tasks");
	if (stages.length > 0) stores.push("workflow");

	return {
		stores,
		// plan
		blocks: blocks.length,
		blockTypes,
		proseOnly: blocks.length > 0 && blocks.every((b) => b.type === "text" || b.type === "steps"),
		phase: s.plan?.phase ?? null,
		revision: s.plan?.revision ?? 0,
		planSteps: planSteps.length,
		planLinked: planSteps.filter((st) => st.taskId).length,
		linearRefs: blocks
			.filter((b) => b.type === "refs")
			.flatMap((b) => (Array.isArray(b.refs) ? b.refs : []))
			.filter((r) => r?.kind === "linear").length,
		// tasks
		tasks: tasks.length,
		tasksLinear: tasks.filter((t) => t.linearKey).length,
		// workflow
		stages: stages.length,
		wfSteps: wfSteps.length,
		wfMirrored: wfSteps.filter((st) => st.taskId).length,
		wfFromPlan: wfSteps.filter((st) => st.planStepId).length,
		wfTriple: wfSteps.filter((st) => st.taskId && st.planStepId).length,
		duplicated,
		nested: wfSteps.filter((st) => st.parentId).length,
		deps: wfSteps.filter((st) => Array.isArray(st.dependsOn) && st.dependsOn.length > 0).length,
		// cost + calls
		snapshots: s.snapshots,
		bytes: s.bytes,
		calls: s.calls,
		planOps: s.planOps,
		upsertTypes: s.upsertTypes,
	};
}

function pct(n, of) {
	return of === 0 ? "—" : `${Math.round((n / of) * 100)}%`;
}

function avg(values) {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function kb(bytes) {
	return `${(bytes / 1024).toFixed(1)} KB`;
}

function row(label, n, of) {
	return `  ${label.padEnd(44)} ${String(n).padStart(5)}/${of}  ${pct(n, of)}`;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const { files, skippedProbes } = transcripts(args.since, args.includeProbes);
	const sessions = [];
	for (const { path, slug, at } of files) {
		const read = readSession(path);
		if (!read) continue;
		sessions.push({ slug, at, ...measure(read) });
	}

	const N = sessions.length;
	const withPlan = sessions.filter((s) => s.stores.includes("plan"));
	const withTasks = sessions.filter((s) => s.stores.includes("tasks"));
	const withWorkflow = sessions.filter((s) => s.stores.includes("workflow"));
	const combos = {};
	for (const s of sessions) bump(combos, s.stores.length === 0 ? "calls only, nothing kept" : s.stores.join("+"));

	const blockTypeSessions = {};
	const blockTypeTotal = {};
	for (const s of withPlan) {
		for (const [type, n] of Object.entries(s.blockTypes)) {
			bump(blockTypeSessions, type);
			blockTypeTotal[type] = (blockTypeTotal[type] ?? 0) + n;
		}
	}
	const phases = {};
	for (const s of withPlan) bump(phases, s.phase ?? "?");

	const summary = {
		since: args.since ? new Date(args.since).toISOString() : null,
		sessions: N,
		skippedProbes,
		stores: { plan: withPlan.length, tasks: withTasks.length, workflow: withWorkflow.length },
		combinations: combos,
		sameWork: {
			// A todo held again as a workflow step.
			mirroredSessions: sessions.filter((s) => s.wfMirrored > 0).length,
			mirroredSteps: sessions.reduce((n, s) => n + s.wfMirrored, 0),
			// A plan step held again as a todo.
			planLinkedSessions: sessions.filter((s) => s.planLinked > 0).length,
			planLinkedSteps: sessions.reduce((n, s) => n + s.planLinked, 0),
			// One item in all three.
			tripleSessions: sessions.filter((s) => s.wfTriple > 0).length,
			tripleSteps: sessions.reduce((n, s) => n + s.wfTriple, 0),
			bothTasksAndWorkflow: sessions.filter((s) => s.stores.includes("tasks") && s.stores.includes("workflow")).length,
		},
		plans: {
			count: withPlan.length,
			blocksAvg: avg(withPlan.map((s) => s.blocks)),
			blocksMax: Math.max(0, ...withPlan.map((s) => s.blocks)),
			blockTypeSessions,
			blockTypeTotal,
			proseOnly: withPlan.filter((s) => s.proseOnly).length,
			withArtifact: withPlan.filter((s) => (s.blockTypes.artifact ?? 0) > 0).length,
			withLinearRefs: withPlan.filter((s) => s.linearRefs > 0).length,
			phases,
			revisionAvg: avg(withPlan.map((s) => s.revision)),
			planReadyCalls: sessions.reduce((n, s) => n + s.calls.plan_ready, 0),
			planAskCalls: sessions.reduce((n, s) => n + s.calls.plan_ask, 0),
			planWriteCalls: sessions.reduce((n, s) => n + s.calls.plan_write, 0),
		},
		tasks: {
			count: withTasks.length,
			itemsAvg: avg(withTasks.map((s) => s.tasks)),
			withLinearKey: withTasks.filter((s) => s.tasksLinear > 0).length,
			todoCalls: sessions.reduce((n, s) => n + s.calls.todo, 0),
		},
		workflow: {
			count: withWorkflow.length,
			duplicateLane: withWorkflow.filter((s) => s.duplicated.length > 0).length,
			withNesting: withWorkflow.filter((s) => s.nested > 0).length,
			withDeps: withWorkflow.filter((s) => s.deps > 0).length,
			workflowWriteCalls: sessions.reduce((n, s) => n + s.calls.workflow_write, 0),
		},
		cost: {
			plan: { snapshotsAvg: avg(withPlan.map((s) => s.snapshots.plan)), bytesAvg: avg(withPlan.map((s) => s.bytes.plan)) },
			tasks: { snapshotsAvg: avg(withTasks.map((s) => s.snapshots.tasks)), bytesAvg: avg(withTasks.map((s) => s.bytes.tasks)) },
			workflow: {
				snapshotsAvg: avg(withWorkflow.map((s) => s.snapshots.workflow)),
				bytesAvg: avg(withWorkflow.map((s) => s.bytes.workflow)),
			},
			totalBytes: sessions.reduce((n, s) => n + s.bytes.plan + s.bytes.tasks + s.bytes.workflow, 0),
		},
	};

	if (args.json) {
		console.log(JSON.stringify({ summary, sessions }, null, 2));
		return;
	}

	if (N === 0) {
		console.log(`No plan, task or workflow activity under ${SESSIONS}. Widen --since, or check the path.`);
		return;
	}

	console.log(`plan-shape — ${N} sessions that used plan, tasks or workflow${summary.since ? ` (started since ${summary.since})` : ""}`);
	if (skippedProbes > 0) {
		console.log(`  ${skippedProbes} hand-run probe transcript(s) skipped — --include-probes to keep them`);
	}
	console.log("\nStores held at the end of the session:");
	console.log(row("plan document", withPlan.length, N));
	console.log(row("task list", withTasks.length, N));
	console.log(row("workflow document", withWorkflow.length, N));
	console.log("  combinations:");
	for (const [combo, n] of Object.entries(combos).sort((a, b) => b[1] - a[1])) {
		console.log(`      ${combo.padEnd(40)} ${String(n).padStart(5)}  ${pct(n, N)}`);
	}

	const sw = summary.sameWork;
	console.log("\nSame work in more than one store (by the ids the extensions write):");
	console.log(row("todo mirrored into the workflow (taskId)", sw.mirroredSessions, N) + `   ${sw.mirroredSteps} steps`);
	console.log(row("plan step materialised as a todo (taskId)", sw.planLinkedSessions, N) + `   ${sw.planLinkedSteps} steps`);
	console.log(row("one item in all three stores", sw.tripleSessions, N) + `   ${sw.tripleSteps} steps`);
	console.log(row("holds BOTH a task list and a workflow", sw.bothTasksAndWorkflow, N));

	const p = summary.plans;
	console.log(`\nPlan documents (${p.count}):`);
	console.log(`  blocks per plan                              avg ${p.blocksAvg.toFixed(1)} · max ${p.blocksMax}`);
	console.log("  block types — sessions using ≥1 (total blocks):");
	const types = [...BLOCK_TYPES, ...Object.keys(blockTypeSessions).filter((t) => !BLOCK_TYPES.includes(t))];
	for (const type of types) {
		const n = blockTypeSessions[type] ?? 0;
		console.log(`      ${type.padEnd(12)} ${String(n).padStart(5)}/${p.count}  ${pct(n, p.count).padStart(4)}   (${blockTypeTotal[type] ?? 0})`);
	}
	console.log(row("prose + checklist only (text/steps)", p.proseOnly, p.count));
	console.log(row("carries an artifact block", p.withArtifact, p.count));
	console.log(row("names a Linear ticket in refs", p.withLinearRefs, p.count));
	console.log(`  phase at end                                 ${Object.entries(phases).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
	console.log(`  revision at end                              avg ${p.revisionAvg.toFixed(1)}`);
	console.log(`  calls                                        plan_write ${p.planWriteCalls} · plan_ready ${p.planReadyCalls} · plan_ask ${p.planAskCalls}`);

	const t = summary.tasks;
	console.log(`\nTask lists (${t.count}):`);
	console.log(`  items per list                               avg ${t.itemsAvg.toFixed(1)}`);
	console.log(row("linked to a Linear key", t.withLinearKey, t.count));
	console.log(`  TodoWrite/TaskCreate/TaskUpdate calls        ${t.todoCalls}`);

	const w = summary.workflow;
	console.log(`\nWorkflow documents (${w.count}):`);
	console.log(row("duplicate lane of one kind", w.duplicateLane, w.count));
	console.log(row("used sub-steps (parentId)", w.withNesting, w.count));
	console.log(row("used dependsOn", w.withDeps, w.count));
	console.log(`  workflow_write calls                         ${w.workflowWriteCalls}`);

	const c = summary.cost;
	console.log("\nSnapshot cost per session (whole-document re-emission per mutation):");
	console.log(`  plan       ${c.plan.snapshotsAvg.toFixed(1).padStart(6)} snapshots   ${kb(c.plan.bytesAvg).padStart(10)}`);
	console.log(`  tasks      ${c.tasks.snapshotsAvg.toFixed(1).padStart(6)} snapshots   ${kb(c.tasks.bytesAvg).padStart(10)}`);
	console.log(`  workflow   ${c.workflow.snapshotsAvg.toFixed(1).padStart(6)} snapshots   ${kb(c.workflow.bytesAvg).padStart(10)}`);
	console.log(`  corpus total                                 ${(c.totalBytes / 1024 / 1024).toFixed(1)} MB across ${N} sessions`);
}

main();
