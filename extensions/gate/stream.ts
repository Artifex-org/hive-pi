/**
 * stream — reading the gate's progress while it is still running.
 *
 * PURE half of the streaming work: the `##hive:substep` line format, the run
 * banner, the stall heartbeat, and the widget spec they accumulate into. The
 * spawning lives in index.ts so all of this is testable without a shell.
 *
 * ## Why the markers exist to be read at all
 *
 * quality-gate already emits one JSON line per check, gated on `QG_SUBSTEPS=1`.
 * It was built for Hive CI, which ingests the same lines to unfold one CI step
 * into per-check rows — so this is not a new protocol, it is a second consumer
 * of a stable one. quality-gate needs no change whatsoever.
 */

/** What one check ended up as, in the widget's vocabulary. */
export type GateOutcome = "passed" | "advisory" | "failed" | "error";

export interface GateCheckProgress {
	name: string;
	outcome: GateOutcome;
	duration_ms?: number;
	message?: string;
	/**
	 * Which step reported this check (hive-check path only, HIV-1929).
	 *
	 * The vendored gate is one flat list of checks, so it never sets this. A Hive
	 * run has two levels — steps, each of which may report checks — and without
	 * the step name forty `ruff`/`mypy` rows from three different shards read as
	 * one undifferentiated list.
	 */
	group?: string;
}

/** The widget spec, matching hive's `gate` envelope (HIV-1366). */
export interface GateProgress {
	status: "running" | "pass" | "fail" | "nosummary";
	mode?: string;
	scope?: string;
	total?: number;
	done: number;
	checks: GateCheckProgress[];
	failures: string[];
	advisories: string[];
	missing_tools: { tool: string; reason?: string }[];
	duration_ms?: number;
	running: string[];
	exit_code?: number;
	/**
	 * Where this gate ran, when it ran somewhere with a page (HIV-1929).
	 *
	 * Only the hive-check path sets these: a fleet run has the full logs, the
	 * artifacts and the per-test detail behind a URL, and an agent that cannot
	 * find it re-runs the gate instead of opening it.
	 */
	url?: string;
	run_number?: number;
	/**
	 * The run's UUID, when this gate ran on the fleet.
	 *
	 * Carried so a reader can FOLLOW the run rather than only link to it. The
	 * `NO VERDICT` path is why it exists: when the follow times out or the call
	 * is aborted, the spec is frozen mid-flight (`nosummary`) and the run keeps
	 * going without it — Hive's transcript card then reports a gate that never
	 * ended, for a run that ended minutes later. A number cannot resolve that:
	 * run numbers are allocated per PIPELINE, so `#3262` is ambiguous on its own,
	 * and the URL is for a human to click, not for a client to parse.
	 */
	run_id?: string;
	/**
	 * The server's own word for the run: `queued`, `running`, `succeeded`, …
	 *
	 * Carried because "waiting for a fleet slot" and "checking your code" are
	 * different facts and the fold cannot otherwise tell them apart — both show
	 * zero finished steps and nothing running. Measured: a check sat behind a PR
	 * gate for 15 minutes reading `running · 0/2`, which is a claim that work was
	 * happening on this code. Only the hive-check path sets it.
	 */
	run_state?: string;
	/**
	 * Seconds this run has been waiting for a fleet slot, from its creation.
	 *
	 * The readout that makes a queue wait legible. `isQueued` already says THAT
	 * a run has not started; without a number beside it the card is a static
	 * label for as long as the wait lasts, which is indistinguishable from a
	 * hung tool — measured 2026-08-17, an agent 27 minutes into a queue wait
	 * whose card read `waiting on Running quality_gate` the entire time, with a
	 * frozen pane behind it and no way to tell the two apart.
	 */
	queued_secs?: number;
}

export function emptyProgress(mode: string, scope: string): GateProgress {
	return {
		status: "running",
		mode,
		scope,
		done: 0,
		checks: [],
		failures: [],
		advisories: [],
		missing_tools: [],
		running: [],
	};
}

const SUBSTEP = /^##hive:substep\s+(\{.*\})\s*$/;
/**
 * `  Mode: quick | Files: staged | Checks: 27` — the run banner.
 *
 * `Files:` is `(.+?)`, not `\w+`: with `--changed --lint-all` (which is what
 * scope:"all" maps to) the label is `lint=full_repo, tests=changed` — commas,
 * spaces and equals signs — and a word-only pattern would silently lose the
 * denominator on the most expensive scope there is.
 */
const BANNER = /^\s*Mode:\s*(.+?)\s*\|\s*Files:\s*(.+?)\s*\|\s*Checks:\s*(\d+)\s*$/;
/**
 * `i still running: mypy (63s), basedpyright (61s) — 4 queued`
 *
 * NOT anchored at the start: the emitter prefixes an `i` glyph (and, when a TTY
 * is attached, colour codes around it). Anchoring here matched nothing.
 */
const HEARTBEAT = /still running:\s*(.+?)(?:\s+—.*)?$/;

/** Map the gate's own outcome words onto the widget's. */
function outcomeOf(raw: unknown, message?: string): GateOutcome {
	// `warn` is reported by the emitter as outcome "passed" with an advisory
	// message, because a red substep inside a green CI step reads as a broken
	// UI. The message is the only way to recover the distinction.
	if (raw === "passed") {
		return message && /advisory/i.test(message) ? "advisory" : "passed";
	}
	if (raw === "failed") return "failed";
	return "error";
}

/**
 * consume folds one line of gate output into the progress spec.
 *
 * Returns whether the spec changed, and whether the line should be HIDDEN from
 * the model — protocol markers are noise in an agent's transcript, and leaving
 * them in teaches it to read `##hive:substep` as output.
 */
export function consume(p: GateProgress, line: string): { changed: boolean; hide: boolean } {
	const marker = SUBSTEP.exec(line);
	if (marker) {
		try {
			const ev = JSON.parse(marker[1]) as Record<string, unknown>;
			const name = typeof ev.name === "string" ? ev.name : undefined;
			if (!name) return { changed: false, hide: true };
			if (ev.phase === "start") {
				// Only the SERIAL runner emits these. Under the parallel runner
				// output interleaves and a start marker would claim a sibling's
				// lines, so the absence of starts is meaningful, not a gap.
				if (!p.running.includes(name)) p.running.push(name);
				return { changed: true, hide: true };
			}
			if (ev.phase === "end") {
				p.running = p.running.filter((n) => n !== name);
				const message = typeof ev.message === "string" && ev.message ? ev.message : undefined;
				const outcome = outcomeOf(ev.outcome, message);
				p.checks.push({
					name,
					outcome,
					duration_ms: typeof ev.duration_ms === "number" ? ev.duration_ms : undefined,
					message,
				});
				p.done = p.checks.length;
				if (outcome === "failed" || outcome === "error") p.failures.push(name);
				if (outcome === "advisory") p.advisories.push(name);
				return { changed: true, hide: true };
			}
			return { changed: false, hide: true };
		} catch {
			// A malformed marker is still protocol noise; hide it, change nothing.
			return { changed: false, hide: true };
		}
	}

	const banner = BANNER.exec(line);
	if (banner) {
		p.mode = banner[1];
		p.scope = banner[2];
		p.total = Number(banner[3]);
		return { changed: true, hide: false };
	}

	const beat = HEARTBEAT.exec(line);
	if (beat) {
		// The heartbeat names what is STILL going, which under the parallel
		// runner is the only source of that fact.
		const names = beat[1]
			.split(",")
			.map((s) => s.trim().replace(/\s*\(\d+s\)$/, ""))
			.filter(Boolean);
		if (names.length) {
			p.running = names.slice(0, 8);
			return { changed: true, hide: false };
		}
	}

	return { changed: false, hide: false };
}

/**
 * finish stamps the terminal state from the gate's own trailer.
 *
 * `nosummary` is its own status rather than being folded into `fail`: a gate
 * that died before emitting a summary made no verdict at all, and the widget
 * must not draw a verdict it did not make.
 */
export function finish(
	p: GateProgress,
	result: {
		passed: boolean;
		total_duration_ms?: number;
		checks?: { name: string; status?: string }[];
		failures?: string[];
		skipped_missing_tools?: ({ tool: string; reason?: string } | string)[];
	} | null,
	exitCode: number | null,
): GateProgress {
	p.running = [];
	if (!result) {
		p.status = "nosummary";
		// A signalled run has NO exit code — `exit_code` is typed `number` in
		// the shared widget contract (HIV-1366), so leave it unset rather than
		// shipping a null an older card will not know how to draw.
		if (typeof exitCode === "number") p.exit_code = exitCode;
		return p;
	}
	// A PASS THAT CHECKED NOTHING IS NOT A PASS — the widget half.
	//
	// render has refused this since its zero-check branch ("NOTHING CHECKED …
	// This is NOT a pass"), but the spec that feeds the deck and the browser
	// card did not, so one run read NOTHING CHECKED in the transcript and PASS
	// on the card, and the card is the glanceable one. Same condition, same
	// reading of an absent `checks` as zero, and `nosummary` — the EXISTING
	// value for "made no verdict" — rather than a new enum member.
	const verdictless = result.passed && (result.checks ?? []).length === 0 && !result.failures?.length;
	p.status = verdictless ? "nosummary" : result.passed ? "pass" : "fail";
	p.duration_ms = result.total_duration_ms;
	// The trailer is authoritative for failures; the markers may have been cut
	// short by a fast-fail exit.
	if (result.failures?.length) p.failures = result.failures;
	// Normalised to objects for the widget, tolerating the older bare-string
	// form on the way in.
	p.missing_tools = (result.skipped_missing_tools ?? []).map((m) =>
		typeof m === "string" ? { tool: m } : m,
	);
	return p;
}

/** The envelope hive's widget registry dispatches on. */
export function widgetEnvelope(p: GateProgress) {
	return { hive_widget: { v: 1 as const, type: "gate" as const, spec: p } };
}
