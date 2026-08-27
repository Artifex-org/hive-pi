/**
 * hive-telemetry — THE ALLOWLIST.
 *
 * This is the only file that constructs what leaves the machine. Review it
 * alone and you have reviewed the privacy boundary: one function, one diff.
 *
 * SENT: model + provider ids, token counts, cost, turns, tool NAMES with call
 * and error counts, gate outcomes, session duration, the git remote as a
 * normalized owner/repo, agent + version, source.
 *
 * NEVER SENT, and with no config option that could enable it: prompts,
 * completions, thinking blocks, tool arguments, tool results, file paths or
 * names, error message strings, commit SHAs or messages, BRANCH NAMES (a branch
 * like feature/acme-corp-migration names a client), cwd, hostname, username,
 * environment variables, or the session file path.
 *
 * There is no code path in this extension that reads `tool_execution_*.args` or
 * `.result` — the capability is absent rather than defaulted-off, which is the
 * difference between a policy and a guarantee.
 */

import type { RunAccumulator } from "./accumulator.ts";
import type { AgentUsagePayload, PayloadGate, PayloadModel, PayloadTool, ResolvedConfig } from "./types.ts";

/** Server-side caps, mirrored so we never send something guaranteed to 400. */
const MAX_MODELS_WIRE = 32;
const MAX_TOOLS_WIRE = 128;
const MAX_GATES_WIRE = 32;

/**
 * buildPayload snapshots the accumulator into the wire shape.
 *
 * `/hive-telemetry` renders the result of THIS function, so the preview a human
 * inspects and the bytes the transport sends cannot drift apart.
 *
 * Totals are cumulative for the life of the run, never deltas: a lost flush then
 * self-heals on the next one and a replayed flush is a server-side no-op, which
 * is what lets the client be nothing more than "retry until 2xx".
 */
export function buildPayload(
	run: RunAccumulator,
	cfg: ResolvedConfig,
	piVersion: string,
	nowMs: number,
): AgentUsagePayload {
	const endedAtMs = run.endedAtMs;
	const payload: AgentUsagePayload = {
		client_run_id: run.runId,
		client_session_id: run.sessionId.slice(0, 128),
		parent_session_id: run.parentSessionId.slice(0, 128),
		seq: run.seq,
		agent: "pi",
		agent_version: piVersion.slice(0, 64),
		source: run.source,
		// The launch that spawned this process, when Hive did (workstation lane
		// or cloud pod — both inject HIVE_LAUNCH_ID). The server uses it to stamp
		// the launch row's session_id, closing a loop the node cannot close
		// itself (it never learns the server session id). A UUID minted by Hive,
		// not a path or a name, so it stays inside this file's allowlist.
		...(process.env.HIVE_LAUNCH_ID ? { launch_id: process.env.HIVE_LAUNCH_ID.slice(0, 64) } : {}),
		repo: resolveRepo(run, cfg),
		status: run.status,
		outcome: run.outcome,
		// Is a human sitting at this? (HIV-1176)
		//
		// Every pi process on the machine reports, and not all of them are
		// sessions: `pi-delegate` spawning pi to answer one question for another
		// agent registers identically — own conversation, two turns, gone in twelve
		// seconds — and each one showed up in the Hive agents workspace as an agent
		// to supervise. Nobody can steer a twelve-second sub-agent call.
		//
		// isTTY, NOT $TMUX. TMUX is INHERITED by a delegate, so one reported that
		// it lived in tmux session "68" with nobody in it; only a real pane makes
		// stdout a tty. A Hive launch runs inside tmux and reads true; a delegate's
		// stdout is a pipe and reads false.
		//
		// HIVE_INTERACTIVE=1 overrides for a supervised session with no tty at
		// all: a cloud launch runs `pi --mode rpc` in a pod, stdout is the
		// wrapper's pipe, and without the override every cloud session would
		// register as an unsupervisable sub-agent call and be hidden from the
		// workspace it exists to appear in. Only the Hive launch path sets it.
		//
		// This is a boolean about the process, never a path or a name, so it stays
		// inside the payload allowlist this file exists to be.
		interactive: Boolean(process.stdout.isTTY) || process.env.HIVE_INTERACTIVE === "1",
		started_at: new Date(run.startedAtMs).toISOString(),
		duration_ms: Math.max(0, Math.round((endedAtMs ?? nowMs) - run.startedAtMs)),
		turns: run.turns,
		tool_calls: run.toolCalls,
		tool_errors: run.toolErrors,
		compactions: run.compactions,
		compaction_overflows: run.compactionOverflows,
		// Spread so the key is ABSENT when no compaction reported a size. The
		// server stores NULL, which is not the same as a context of 0.
		...(run.compactionTokensBefore !== undefined
			? { compaction_tokens_before: Math.max(0, Math.round(run.compactionTokensBefore)) }
			: {}),
		models: buildModels(run),
		tools: buildTools(run),
		gates: buildGates(run),
	};
	// The server rejects an ended_at on a non-terminal snapshot and requires one
	// on a terminal snapshot, so the two fields move together or not at all.
	if (run.status === "ended" && endedAtMs !== null) {
		payload.ended_at = new Date(endedAtMs).toISOString();
	}
	return payload;
}

/**
 * resolveRepo emits the git remote's owner/repo, or the pseudonymous
 * `local-<hash>` bucket for a directory that is not a repo. It never emits a
 * filesystem path — a directory name can name a client, and the metrics-only
 * rule would be meaningless if it shipped. The server rejects path-shaped
 * values too, so this is checked on both sides.
 */
function resolveRepo(run: RunAccumulator, cfg: ResolvedConfig): string {
	const override = cfg.projectOverride?.trim();
	if (override) return override.slice(0, 200);
	const project = run.project;
	if (!project) return "";
	return (project.repo || project.projectHint).slice(0, 200);
}

function buildModels(run: RunAccumulator): PayloadModel[] {
	const out: PayloadModel[] = [];
	for (const bucket of run.models.values()) {
		if (out.length >= MAX_MODELS_WIRE) break;
		// A model that burned tokens but reports ZERO cost has no entry in pi's
		// bundled price table — it is unpriced, not free. Reporting it as
		// api_key would have the server classify it `metered`, and the dashboard
		// would then state "$0.00 billable" for real work: confidently wrong in
		// the flattering direction, the exact failure the three-way split exists
		// to prevent. Downgrade to `unknown` so the server files it as
		// unclassified and it lands in neither total.
		// Measured 2026-08-05: cursor/composer-2-5 reports 16920 in / 150 out at
		// cost 0.
		const unpriced = bucket.cost === 0 && bucket.input + bucket.output > 0;
		out.push({
			model: bucket.model.slice(0, 128),
			provider: bucket.provider.slice(0, 64),
			auth_mode: unpriced ? "unknown" : bucket.authMode,
			turns: bucket.turns,
			input_tokens: Math.max(0, Math.round(bucket.input)),
			output_tokens: Math.max(0, Math.round(bucket.output)),
			cache_read_tokens: Math.max(0, Math.round(bucket.cacheRead)),
			cache_write_tokens: Math.max(0, Math.round(bucket.cacheWrite)),
			// Spread so the key is ABSENT when no turn reported a breakdown,
			// rather than sent as 0. The server distinguishes NULL from 0 and a
			// zero here would assert a measurement no provider made.
			...(bucket.reasoning !== undefined
				? { reasoning_tokens: Math.max(0, Math.round(bucket.reasoning)) }
				: {}),
			// A non-finite cost would make every SUM over the server's table
			// Infinity, org-wide and permanently. The server rejects it; we
			// never send it in the first place.
			cost_usd: Number.isFinite(bucket.cost) && bucket.cost > 0 ? bucket.cost : 0,
		});
	}
	return out;
}

function buildTools(run: RunAccumulator): PayloadTool[] {
	const out: PayloadTool[] = [];
	for (const [name, bucket] of run.tools) {
		if (out.length >= MAX_TOOLS_WIRE) break;
		const errors = Math.min(bucket.errors, bucket.calls);
		out.push({
			tool_name: name.slice(0, 128),
			calls: bucket.calls,
			// The server CHECKs errors <= calls; clamp rather than be rejected.
			errors,
			// Omitted entirely when this tool never errored: the column is
			// nullable and a NULL there means NOT REPORTED, which the server's
			// report keeps distinct from "reported, and none". Sending `{}`
			// would collapse that distinction.
			//
			// Counts are clamped to the same `errors` total for the same reason
			// the total is clamped — the pair must stay internally consistent,
			// and a kind map summing above its own error count is the kind of
			// contradiction that makes a whole panel untrustworthy.
			...(bucket.errorKinds && bucket.errorKinds.size > 0
				? { error_kinds: buildErrorKinds(bucket.errorKinds, errors) }
				: {}),
		});
	}
	return out;
}

/**
 * buildErrorKinds serialises one tool's kind counts, never exceeding the tool's
 * own clamped error total.
 *
 * Kinds are emitted largest-first so that if the budget does bind, what
 * survives is the dominant cause rather than whichever key the Map happened to
 * see first. A remainder is dropped silently rather than folded into `other`:
 * inflating `other` would make it look like a real classification result when
 * it is actually a truncation artifact.
 */
function buildErrorKinds(kinds: Map<string, number>, budget: number): Record<string, number> {
	const out: Record<string, number> = {};
	let left = budget;
	const sorted = [...kinds.entries()].sort((a, b) => b[1] - a[1]);
	for (const [kind, count] of sorted) {
		if (left <= 0) break;
		const n = Math.min(count, left);
		if (n <= 0) continue;
		out[kind] = n;
		left -= n;
	}
	return out;
}

function buildGates(run: RunAccumulator): PayloadGate[] {
	const out: PayloadGate[] = [];
	for (const [name, bucket] of run.gates) {
		if (out.length >= MAX_GATES_WIRE) break;
		out.push({
			gate_name: name.slice(0, 64),
			passed: bucket.passed,
			failed: bucket.failed,
			timed_out: bucket.timedOut,
			skipped: bucket.skipped,
			duration_ms: Math.max(0, Math.round(bucket.durationMs)),
		});
	}
	return out;
}
