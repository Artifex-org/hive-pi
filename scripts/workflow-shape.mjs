#!/usr/bin/env node
/**
 * workflow-shape — what the `workflow` extension actually produces, measured
 * against real sessions rather than against its own tests.
 *
 * WHY THIS EXISTS. The workflow document is the one extension output whose
 * quality no test can see. Every unit test in `test/workflow-state.test.ts`
 * passes on a document the schema permits; none of them can tell you that 13 of
 * 15 live sessions carried two "Execute" lanes, that the research lane landed
 * after the work it precedes 11 times out of 11, or that `parentId` — a feature
 * with a depth cap, cycle refusal, cascade delete and a whole nested rendering
 * path in Hive's web UI — had never once been used in 206 ops. Those numbers
 * came from reading the session transcripts, and everything worth fixing in the
 * round that followed came from them.
 *
 * So this is the instrument, not a one-off. Run it before changing the
 * extension and after; the numbers are the argument.
 *
 * USAGE
 *   node scripts/workflow-shape.mjs [--since '2026-08-17 12:00'] [--json]
 *                                   [--include-probes]
 *
 * `--since` is when the session STARTED, because that is when it picked up its
 * extension code — pass the deploy time to read a build.
 *
 * Hand-run probe sessions (started in a scratchpad or under /tmp, to check a
 * deploy) are EXCLUDED by default and the count of them is printed.
 * `--include-probes` keeps them, for when the probe is the subject rather than
 * the contaminant. See `PROBE_SLUG`.
 *
 * `asked for a template lane` is out of model-authored sessions, not out of
 * "sessions that should have asked" — nothing records whether a session was
 * audit-shaped, so the honest denominator is the one that is knowable, and the
 * figure reads low because most sessions are none of the templated shapes.
 *
 * READING `duplicate lane of one kind`. It counts two different causes and the
 * second one is not fixed. (a) The mirror's lane and a model lane of the same
 * kind, which adoption now merges. (b) The model giving several stages the SAME
 * kind — measured live: a session labelled Triage, Fix and Verification all
 * `plan`, so nothing matched the mirror's `execute` lane and its todos sat in a
 * fourth box restating the same three phases. `kind` is doing two jobs, a loose
 * label for the model and the adoption/ranking key for this code, and the model
 * treats it as the first. Until that is resolved, read a duplicate count as an
 * upper bound on (a).
 *
 * It reads pi's own session transcripts (`~/.pi/agent/sessions/<slug>/*.jsonl`),
 * which are local and already on disk — no Hive call, no database, nothing that
 * costs the fleet anything.
 *
 * READING THE OUTPUT. Two populations share the corpus and they must not be
 * averaged together: sessions from before stages were created lazily open with
 * a seeded six-stage template, so they show six stages, four dependency edges
 * and zero tool calls no matter what the model did. `classify()` separates them
 * on that signature. Only the `authored` population says anything about how the
 * tool is doing; the `seeded` count is there so you can watch it drain as old
 * sessions age out, and so a sudden rise tells you a stale build is deployed
 * somewhere.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSIONS = join(homedir(), ".pi", "agent", "sessions");

/** The kinds the delivery lane chains — its four edges are its fingerprint. */
const SEED_STAGES = ["frame", "plan", "execute", "verify", "deliver", "consolidate"];

/**
 * A session run by whoever is doing the measuring, rather than by the fleet.
 *
 * Slugs are the working directory with the separators flattened, so a session
 * started in a scratchpad or under /tmp shows up as
 * `--tmp-claude-1000--…-scratchpad-…--`. Those are probes: sessions started BY
 * HAND to check a deploy. They belong in the corpus when the probe is the
 * subject and nowhere near it when the fleet is.
 *
 * This is not hygiene, it is the difference between a number and a wish. The
 * first post-deploy reading taken with this script said "3 sessions, 0
 * duplicate lanes" — and two of the three were probes I had run myself minutes
 * earlier, in exactly the shape I was hoping to see. A metric that includes the
 * measurer is how you talk yourself into a result.
 */
const PROBE_SLUG = /(^|-)(tmp|scratchpad)(-|$)/;

function parseArgs(argv) {
	const args = { since: 0, json: false, includeProbes: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--json") args.json = true;
		else if (argv[i] === "--include-probes") args.includeProbes = true;
		else if (argv[i] === "--since") {
			const raw = argv[++i];
			// UTC unless the caller says otherwise. Transcript names are Z-stamped,
			// so a bare "21:30" read as LOCAL time silently shifts the cutover by
			// the box's offset — measured: on a UTC+2 box it admitted every session
			// back to 19:30 UTC and reported 11 "post-deploy" sessions when one had
			// started.
			const at = Date.parse(/[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
			if (Number.isNaN(at)) throw new Error(`--since: cannot parse "${raw}"`);
			args.since = at;
		}
	}
	return args;
}

/**
 * When a session STARTED, from its filename.
 *
 * Transcripts are named `2026-08-17T21-30-40-182Z_<uuid>.jsonl`. Falls back to
 * mtime for a name that does not parse.
 */
function startedAt(file, path) {
	const stamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(file);
	if (!stamp) return statSync(path).mtimeMs;
	const [, y, mo, d, h, mi, s, ms] = stamp;
	return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms);
}

/**
 * Every transcript whose session STARTED since `since`, newest first.
 *
 * Start, not mtime, and the difference is not academic: the question this
 * script answers is "what does build X produce", and a session picks its
 * extension code up when it starts. Filtering on mtime includes every
 * long-running session that merely got appended to after the cutover — which
 * is exactly the population still running the OLD code, so the first
 * post-deploy reading was dominated by sessions that could not possibly have
 * changed. It made a clean before/after unreadable.
 */
function transcripts(since, includeProbes) {
	const out = [];
	let skippedProbes = 0;
	let slugs;
	try {
		slugs = readdirSync(SESSIONS, { withFileTypes: true });
	} catch {
		return { files: out, skippedProbes };
	}
	for (const slug of slugs) {
		if (!slug.isDirectory()) continue;
		const probe = PROBE_SLUG.test(slug.name);
		const dir = join(SESSIONS, slug.name);
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".jsonl")) continue;
			const path = join(dir, file);
			const at = startedAt(file, path);
			if (at < since) continue;
			// COUNTED, not silently dropped. An exclusion you cannot see is the
			// same defect as an inclusion you cannot see — the reader has to be
			// able to tell that a filter ran and how much it took.
			if (probe && !includeProbes) {
				skippedProbes++;
				continue;
			}
			out.push({ path, slug: slug.name, at });
		}
	}
	return { files: out.sort((a, b) => b.at - a.at), skippedProbes };
}

/**
 * The last workflow snapshot in a transcript, plus every op that was sent.
 *
 * Line-at-a-time with a cheap substring guard first: these files run to
 * megabytes and most lines are turns, not workflow writes.
 */
function readSession(path) {
	let doc = null;
	const ops = [];
	let calls = 0;
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	for (const line of text.split("\n")) {
		if (!line.includes("workflow")) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.customType === "workflow") {
			doc = entry.data?.doc ?? doc;
			continue;
		}
		for (const block of entry.message?.content ?? []) {
			if (block?.name !== "workflow_write") continue;
			// Providers disagree about the field name, and one of them ships it as
			// a JSON string. Getting this wrong reads as "the tool was never used".
			let input = block.input ?? block.arguments ?? {};
			if (typeof input === "string") {
				try {
					input = JSON.parse(input);
				} catch {
					input = {};
				}
			}
			const batch = Array.isArray(input.ops) ? input.ops : [];
			if (batch.length > 0) calls++;
			ops.push(...batch);
		}
	}
	return doc ? { doc, ops, calls } : null;
}

/**
 * Which build produced this document.
 *
 * A seeded document has all six template stages and no tool call to explain
 * them. Without this split the metrics drift as the two populations mix: the
 * seed contributes a perfect stage order and four dependency edges it did not
 * earn, which flatters every number this script exists to watch.
 */
function classify(session) {
	const kinds = session.doc.stages.map((s) => s.kind);
	const seeded = SEED_STAGES.every((k) => kinds.includes(k)) && session.calls === 0;
	if (seeded) return "seeded";
	return session.calls > 0 ? "authored" : "machine-only";
}

/** Rank order the extension places stages by; a lower rank happens earlier. */
const RANKED = ["frame", "research", "plan", "execute", "verify", "deliver", "consolidate"];

function measure(session) {
	const stages = session.doc.stages;
	const kinds = stages.map((s) => s.kind);
	const steps = stages.flatMap((s) => s.steps ?? []);

	// A kind appearing twice is the duplicate-lane defect. Counted per kind so a
	// deliberate second pass (one extra) is distinguishable from a lane that
	// re-forked on every turn.
	const seen = new Map();
	for (const k of kinds) seen.set(k, (seen.get(k) ?? 0) + 1);
	const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);

	// An inversion is a ranked stage sitting after one that ranks later than it.
	let inversions = 0;
	const ranked = kinds.map((k) => RANKED.indexOf(k)).filter((r) => r >= 0);
	for (let i = 1; i < ranked.length; i++) {
		if (ranked[i] < ranked[i - 1]) inversions++;
	}

	return {
		stages: stages.length,
		steps: steps.length,
		calls: session.calls,
		ops: session.ops.length,
		duplicated,
		inversions,
		nested: steps.filter((s) => s.parentId).length,
		deps: steps.filter((s) => (s.dependsOn ?? []).length > 0).length,
		notes: steps.filter((s) => s.note).length,
		// Ops the model sent that name an id the document does not use. Before the
		// upsert change these were rejected outright, taking the whole opening
		// declaration with them.
		clientKeyOps: session.ops.filter(
			(o) => typeof o.id === "string" && !/^s\d+(\.\d+)?$/.test(o.id),
		).length,
		parentIdOps: session.ops.filter((o) => o.parentId).length,
		deliveryOps: session.ops.filter((o) => o.op === "delivery").length,
		// Which template lanes were asked for, by name.
		//
		// Kept SEPARATE from `deliveryOps` above, though `{op:"delivery"}` and
		// `{op:"template",name:"delivery"}` build the same lane: the first is the
		// older spelling that sessions in flight still send, and folding them
		// together would let an old session's habit read as adoption of the new
		// op. The question this metric exists to answer is whether models reach
		// for a thing they have never used before, and that answer must not be
		// contaminated by one they already had.
		templateOps: session.ops
			.filter((o) => o.op === "template" && typeof o.name === "string")
			.map((o) => o.name),
	};
}

function pct(n, of) {
	return of === 0 ? "—" : `${Math.round((n / of) * 100)}%`;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const sessions = [];
	const { files, skippedProbes } = transcripts(args.since, args.includeProbes);
	for (const { path, slug } of files) {
		const read = readSession(path);
		if (!read) continue;
		sessions.push({ slug, kind: classify(read), ...measure(read) });
	}

	const authored = sessions.filter((s) => s.kind === "authored");
	const seeded = sessions.filter((s) => s.kind === "seeded").length;
	const machineOnly = sessions.filter((s) => s.kind === "machine-only").length;
	const totalOps = authored.reduce((n, s) => n + s.ops, 0);

	const summary = {
		sessions: sessions.length,
		authored: authored.length,
		seeded,
		machineOnly,
		ops: totalOps,
		calls: authored.reduce((n, s) => n + s.calls, 0),
		duplicateLane: authored.filter((s) => s.duplicated.length > 0).length,
		inverted: authored.filter((s) => s.inversions > 0).length,
		withNesting: authored.filter((s) => s.nested > 0).length,
		withDeps: authored.filter((s) => s.deps > 0).length,
		withNotes: authored.filter((s) => s.notes > 0).length,
		nestingOps: authored.reduce((n, s) => n + s.parentIdOps, 0),
		clientKeyOps: authored.reduce((n, s) => n + s.clientKeyOps, 0),
		deliveryOps: authored.reduce((n, s) => n + s.deliveryOps, 0),
		skippedProbes,
		templates: authored
			.flatMap((s) => s.templateOps)
			.reduce((acc, name) => ({ ...acc, [name]: (acc[name] ?? 0) + 1 }), {}),
		withTemplate: authored.filter((s) => s.templateOps.length > 0).length,
	};

	if (args.json) {
		console.log(JSON.stringify({ summary, sessions }, null, 2));
		return;
	}

	if (sessions.length === 0) {
		console.log(`No workflow documents under ${SESSIONS}. Widen --since, or check the path.`);
		return;
	}

	const n = authored.length;
	console.log(`workflow-shape — ${sessions.length} sessions with a workflow document`);
	console.log(`  ${n} model-authored · ${seeded} seeded (old build) · ${machineOnly} machine-only`);
	console.log(`  ${summary.calls} tool calls, ${totalOps} ops`);
	if (skippedProbes > 0) {
		// TRANSCRIPTS, not sessions: the filter runs before the file is read, so
		// some of these carry no workflow document and would not have appeared in
		// the count above anyway. Saying "sessions" would overstate what the
		// exclusion removed, which is the same species of imprecision this whole
		// filter exists to correct.
		console.log(`  ${skippedProbes} hand-run probe transcript(s) skipped — --include-probes to keep them`);
	}
	console.log();
	console.log("Of the model-authored sessions:");
	console.log(`  duplicate lane of one kind   ${summary.duplicateLane}/${n}  ${pct(summary.duplicateLane, n)}`);
	console.log(`  stages out of canonical order ${summary.inverted}/${n}  ${pct(summary.inverted, n)}`);
	console.log(`  used sub-steps (parentId)     ${summary.withNesting}/${n}  ${pct(summary.withNesting, n)}`);
	console.log(`  used dependsOn                ${summary.withDeps}/${n}  ${pct(summary.withDeps, n)}`);
	console.log(`  recorded a divergence note    ${summary.withNotes}/${n}  ${pct(summary.withNotes, n)}`);
	// The denominator is model-authored sessions, NOT "sessions that should have
	// asked". Whether a session was audit-shaped or incident-shaped is not
	// recorded anywhere, and inferring it from the goal text would be a
	// classifier whose errors land silently in a denominator — a ratio that
	// looks more precise than it is. This one is honest and slightly pessimistic:
	// most sessions are none of the templated shapes.
	console.log(`  asked for a template lane     ${summary.withTemplate}/${n}  ${pct(summary.withTemplate, n)}`);
	console.log("\nOp-level:");
	console.log(`  parentId ops                  ${summary.nestingOps}`);
	console.log(`  caller-supplied ids           ${summary.clientKeyOps}`);
	console.log(`  {op:"delivery"} (old spelling) ${summary.deliveryOps}`);
	const named = Object.entries(summary.templates).sort((a, b) => b[1] - a[1]);
	console.log(`  {op:"template"}               ${named.length === 0 ? 0 : ""}`);
	for (const [name, count] of named) console.log(`      ${name.padEnd(24)} ${count}`);

	const worst = authored.filter((s) => s.duplicated.length > 0 || s.inversions > 0).slice(0, 10);
	if (worst.length > 0) {
		console.log("\nSessions still showing a defect:");
		for (const s of worst) {
			const bits = [];
			if (s.duplicated.length) bits.push(`duplicate ${s.duplicated.join(", ")}`);
			if (s.inversions) bits.push(`${s.inversions} inversion(s)`);
			console.log(`  ${s.slug.slice(0, 52).padEnd(52)} ${bits.join(" · ")}`);
		}
	}
}

main();
