/**
 * Transcript discovery shared by the shape scripts (`workflow-shape.mjs`,
 * `plan-shape.mjs`): where pi keeps session transcripts, how a session's START
 * time is read from its filename, which slugs are hand-run probes, and the
 * `--since / --json / --include-probes` argument parser. Every comment here was
 * earned by a misreading the first script made; the second script exists so the
 * same numbers can be taken over the plan document, and it must not re-learn them.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SESSIONS = join(homedir(), ".pi", "agent", "sessions");

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
export const PROBE_SLUG = /(^|-)(tmp|scratchpad)(-|$)/;

export function parseArgs(argv) {
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
export function startedAt(file, path) {
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
export function transcripts(since, includeProbes) {
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
