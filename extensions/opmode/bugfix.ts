/**
 * Bugfix mode's evidence protocol — the state machine behind
 * `bugfix_evidence` and `bugfix_root_cause`, as pure functions.
 *
 * Lifted out of `index.ts` so the pi extension and the Claude adapter's MCP
 * tools (`claude/mcp/bugfix-tools.ts`) bind evidence by the same rules and
 * refuse with the same words. What differs per host is only WHERE results are
 * observed (pi: its tool_result events; Claude: the session transcript) and
 * what the two tools are called there — every message that names a tool takes
 * a `BugfixToolNames`.
 *
 * The protocol: reproduce → hypothesize → instrument → confirm →
 * (root cause, then the edit) → reverify. Every phase except `blocked` binds
 * to a real observed result by id; `reproduce` and `reverify` share a
 * `reproduction_key`, which is what makes the re-verification a re-run of the
 * reproduction rather than a new claim.
 */

import { parseResultHeader, type JobStatus } from "../background/jobs.ts";
import { canonicalMcpToolName } from "../mcp-common/names.ts";
import type { OpMode } from "./modes.ts";

/** What the two tools are called in the host. */
export interface BugfixToolNames {
	evidence: string;
	rootCause: string;
}

export const PI_BUGFIX_TOOLS: BugfixToolNames = { evidence: "bugfix_evidence", rootCause: "bugfix_root_cause" };

/** The order, spelled the way the `phase` argument is spelled. */
export function phaseOrder(names: BugfixToolNames = PI_BUGFIX_TOOLS): string {
	return `reproduce → hypothesize → instrument → confirm → (${names.rootCause}, then the edit) → reverify`;
}

/**
 * What an observed run says about the code: it failed, it passed, or it made
 * no claim (a job we timed out or a human cancelled, a CI run still going, a
 * background job that has only just started).
 *
 * Three values, not a boolean, because "did not fail" is not "passed": with a
 * boolean, a timed-out job read as a passing re-verification.
 */
export type Verdict = "failed" | "passed" | "indeterminate";

/**
 * A completed tool result the evidence protocol observed.
 *
 * `family` is the kind of execution it reports, which is what re-verification
 * must match — not the tool name. Every shell wrapper (`bash`, a background
 * job pulled or announced) is one family, so the same reproduction rerun
 * through a different scheduler is the same evidence; every Hive run record is
 * another. Any other tool is its own family.
 */
export type ObservedResult = {
	name: string;
	family: string;
	verdict: Verdict;
	text: string;
	/**
	 * For a Hive run record: WHICH work it judged (`project|pipeline|branch`)
	 * and which run. Without them a reverify could read any green run — an old
	 * failure reproduced, an unrelated pass "re-verified" (review of #104).
	 * get_task_logs carries neither (only task_id and attempt).
	 */
	subject?: string;
	runId?: string;
};

/** The family every shell execution belongs to, however it was scheduled. */
export const SHELL_FAMILY = "shell";
/** The family of Hive CI run records (see RUN_RECORD_READERS). */
export const HIVE_RUN_FAMILY = "hive run";

/**
 * Tools whose result IS the verdict of a run that already happened, and the
 * structured field that holds it — keyed by canonical (adapter) MCP name, so
 * `mcp__hive__get_task_logs` and `hive_get_task_logs` are one entry.
 *
 * The rule this encodes: a reproduction is a run that failed, and reading
 * the record of a CI run that failed is observing that run — the retrieval
 * succeeding is not a statement about the code (papercut 2026-10-04T16:48:
 * a failed CI attempt with two FAILED tests refused because "the log retrieval
 * tool itself completed successfully"). It stays a REVIEWED LIST read from the
 * server's own state field: an arbitrary read whose text says FAILED (a file, a
 * ticket) still binds nothing.
 *
 * Shapes from hive's internal/mcp: get_task_logs → `attempt_state`;
 * explain_failure, get_run, wait_for_run → `run.state`.
 */
const RUN_RECORD_READERS: Record<string, (body: Record<string, unknown>) => unknown> = {
	hive_get_task_logs: (body) => body.attempt_state,
	hive_explain_failure: (body) => runState(body),
	hive_get_run: (body) => runState(body),
	hive_wait_for_run: (body) => runState(body),
};

/** `project|pipeline|branch` and the run id of a run record, when it names them. */
function runIdentity(body: Record<string, unknown> | undefined): { subject?: string; runId?: string } {
	const run = body?.run;
	if (!run || typeof run !== "object") return {};
	const r = run as Record<string, unknown>;
	const parts = [r.project, r.pipeline, r.branch];
	const subject = parts.every((part) => typeof part === "string" && part.length > 0) ? parts.join("|") : undefined;
	const runId = typeof r.id === "string" && r.id.length > 0 ? r.id : undefined;
	return { ...(subject ? { subject } : {}), ...(runId ? { runId } : {}) };
}

/**
 * Is `observed` the same Hive work as the reproduction, run again? Only for the
 * run-record family: the same project, pipeline and branch, a different run.
 * A reproduction read from task logs names no run, so nothing can be shown to
 * be its rerun — the caller is told to bind a run record instead.
 */
export function sameHiveWorkRerun(repro: { subject?: string; runId?: string }, observed: { subject?: string; runId?: string }): boolean {
	if (!repro.subject || !observed.subject || repro.subject !== observed.subject) return false;
	return !!observed.runId && observed.runId !== repro.runId;
}

function runState(body: Record<string, unknown>): unknown {
	const run = body.run;
	return run && typeof run === "object" ? (run as Record<string, unknown>).state : undefined;
}

/** A Hive run/attempt state as a verdict. Only the two terminal answers count. */
function hiveStateVerdict(state: unknown): Verdict {
	if (state === "failed") return "failed";
	if (state === "succeeded") return "passed";
	return "indeterminate";
}

/**
 * A background job's status as a verdict. `timeout` and `canceled` say nothing
 * about the code (see JobStatus), and `running` has not finished.
 */
export function jobVerdict(status: JobStatus): Verdict {
	if (status === "failed") return "failed";
	if (status === "done") return "passed";
	return "indeterminate";
}

/**
 * Classify one tool result. `fullText` is the WHOLE result: a run record's
 * verdict can sit well past any preview cut (Go sorts map keys, so
 * explain_failure's `failures` with their log tails come before `run`).
 */
export function observe(
	name: string,
	isError: boolean,
	fullText: string,
	structured?: unknown,
	ownText: string = fullText,
): ObservedResult {
	const text = fullText.slice(0, 1200);
	const canonical = canonicalMcpToolName(name);
	const reader = RUN_RECORD_READERS[canonical];
	if (reader) {
		if (isError) return { name, family: HIVE_RUN_FAMILY, verdict: "indeterminate", text };
		// The LEADING JSON value of the tool's own first text part. Other
		// extensions' tool_result handlers run first and append notes — narrate
		// as a further part, toolhints/guards-bridge INTO the last text part —
		// so neither the joined text nor the whole part is guaranteed to parse.
		const body = structured && typeof structured === "object" ? structured : leadingJSON(ownText);
		const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
		const state = record ? reader(record) : undefined;
		return { name, family: HIVE_RUN_FAMILY, verdict: hiveStateVerdict(state), text, ...runIdentity(record) };
	}
	// `background_bash` returns "started bg-N"; the run has not happened yet.
	if (name === "background_bash") return { name, family: SHELL_FAMILY, verdict: "indeterminate", text };
	const family = name === "bash" ? SHELL_FAMILY : canonical;
	return { name, family, verdict: isError ? "failed" : "passed", text };
}

/**
 * The JSON object or array at the start of `text`, ignoring whatever follows
 * it; undefined when the text does not open with one. Scans to the matching
 * close bracket outside strings, then hands exactly that span to JSON.parse,
 * so validity is still JSON.parse's call.
 */
export function leadingJSON(text: string): unknown {
	const start = text.search(/\S/);
	if (start < 0 || (text[start] !== "{" && text[start] !== "[")) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, i + 1));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

/**
 * The refusal for a missing or unknown tool_call_id — WITH the ids it was
 * checked against.
 *
 * The id lives in the tool-event stream, which the model never sees: Pi's
 * rendered transcript carries no tool-call ids, so the bare "needs the id"
 * refusal demanded a value the caller had no way to produce. Agents holding a
 * live reproduction were refused on every attempt and the mandated protocol
 * could not be completed at all (HIV-3078 — 6+ blocking papercuts in the week
 * to 2026-08-30). Handing over the newest observed ids turns the dead end
 * into a one-call retry, without trusting anything model-authored: the ids
 * still come from the event stream, and the binding checks are unchanged.
 */
export function refusalWithCandidates(results: Map<string, ObservedResult>, requested: string | undefined): string {
	const head = requested
		? `Tool result ${requested} was not observed in this session.`
		: "Bugfix evidence needs the id of a completed tool result from this session.";
	const recent = [...results.entries()].slice(-8).reverse();
	if (recent.length === 0) {
		return `${head} No completed tool results have been observed yet — run the reproduction first, then record it.`;
	}
	const rows = recent.map(
		([id, r]) => `  ${id}  ${r.name}${r.verdict === "failed" ? "  (failed)" : ""}  ${r.text.replace(/\s+/g, " ").slice(0, 70)}`,
	);
	// Name `reproduction_key` HERE, in the message read immediately before the
	// retry. It is `Type.Optional` in the schema and mandatory for the first
	// phase, so a caller that answered this refusal perfectly — a listed id, a
	// failing one — was refused AGAIN on the next call, for a field this message
	// had never mentioned. Two refusals for one call is the dead end the
	// candidate list was supposed to end; listing ids only moved it one call
	// later. The example points at the newest FAILING result because `reproduce`
	// rejects a passing one, and handing over an id that the next line rejects
	// is the same failure wearing a different sentence.
	const example = recent.find(([, r]) => r.verdict === "failed")?.[0] ?? recent[0]![0];
	return (
		`${head} Recent completed results, newest first — pass one of these ids as tool_call_id:\n${rows.join("\n")}\n` +
		`Phase "reproduce" also needs a reproduction_key — any stable name for this bug, repeated on the later "reverify" call: ` +
		`{"phase": "reproduce", "tool_call_id": "${example}", "reproduction_key": "targeted-test"}`
	);
}

/** The states the evidence protocol moves through; `phase` below holds one. */
export type ProtocolState = "reproduce" | "hypothesize" | "instrument" | "confirm" | "fix" | "done" | "blocked";

/**
 * The `bugfix_evidence` phase argument each state is waiting for.
 *
 * Deliberately not the identity map, which is exactly why the caller could not
 * infer it: after `confirm` the machine sits at `fix` — the state where
 * `bugfix_root_cause` unlocks the editors — and the evidence call it wants next
 * is `reverify`. There is no `fix` phase argument to pass, and nothing the agent
 * could see said so.
 */
const EXPECTED_CALL: Record<ProtocolState, string | null> = {
	reproduce: "reproduce",
	hypothesize: "hypothesize",
	instrument: "instrument",
	confirm: "confirm",
	fix: "reverify",
	done: null,
	blocked: null,
};

/** The order, spelled the way the `phase` argument is spelled. */

/**
 * The refusal for a `reproduce` call that named a real result but cannot bind.
 *
 * The old wording — "needs an actual failing result and a stable reproduction
 * key" — fired for either half and named neither, so an agent that had just
 * been handed a failing id by refusalWithCandidates read it as a second verdict
 * on the id: the one thing that was right. It then went back to hunting ids.
 * Say which half is missing, and show the call that would have worked.
 */
const JOB_STATUSES: readonly JobStatus[] = ["running", "done", "failed", "timeout", "canceled"];

export function isJobStatus(value: unknown): value is JobStatus {
	return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

function reproduceRefusal(id: string, observed: ObservedResult, key: string | undefined): string {
	const faults: string[] = [];
	if (observed.verdict === "indeterminate") {
		faults.push(`${id} (${observed.name}) reached no verdict — still running, timed out or cancelled — so it is not a reproduction`);
	} else if (observed.verdict !== "failed") {
		faults.push(`${id} (${observed.name}) completed without failing, so it is not a reproduction — bind the run that shows the bug`);
	}
	if (!key) {
		faults.push(
			`reproduction_key is missing: any stable name for this bug will do. It is optional in the schema because the later ` +
				`phases do not all take it, but this phase requires it, and "reverify" must repeat the same value`,
		);
	}
	// The example may only echo the id back when the id was the good half. When
	// the run PASSED, printing it as the example would recommend the call that
	// just failed — the same self-contradiction, one refusal further on, that
	// this whole change exists to remove.
	const exampleID = observed.verdict === "failed" ? id : "<id of the failing run>";
	return (
		`Read as phase "reproduce", the failing baseline. ${faults.join(". ")}. ` +
		`Example: {"phase": "reproduce", "tool_call_id": "${exampleID}", "reproduction_key": "targeted-test"}`
	);
}

/**
 * The refusal for everything that is not a first-phase bind, split by WHICH
 * ordering went wrong.
 *
 * One sentence used to cover four distinct faults ("out of order, lacks a
 * hypothesis, or is not a distinct passing run of the same reproduction key and
 * tool"), leaving the caller to guess which had happened and to re-derive the
 * order by trial — on a protocol that is mandatory and documented nowhere it
 * can read. The machine holds both halves, the phase it read and the phase it
 * wants; only the message collapsed them.
 */
function orderingRefusal(requested: string, state: ProtocolState, detail: string | null, names: BugfixToolNames): string {
	if (detail === null) {
		const expected = EXPECTED_CALL[state];
		const wants = expected
			? `it is waiting for phase "${expected}"`
			: state === "done"
				? "this reproduction is already re-verified — there is nothing further to record"
				: "the investigation is marked blocked";
		return `Read as phase "${requested}", but ${wants}. Order: ${phaseOrder(names)}.`;
	}
	return `Phase "${requested}" is the right next step, but ${detail}. Order: ${phaseOrder(names)}.`;
}

/** A reproduction: one model-supplied key bound to one observed failing run. */
export type Reproduction = { key: string; failingCallID: string; toolName: string; family: string; subject?: string; runId?: string };

/**
 * Why a call whose phase WAS the expected one still could not be recorded.
 *
 * Each phase has exactly one further requirement, and `reverify` has four at
 * once — so that one is enumerated rather than summarised. An agent told "not a
 * distinct passing run of the same reproduction key and tool" has to test four
 * hypotheses against a gate that answers one bit per call; told which of the
 * four missed, it fixes the call.
 */
function payloadFault(
	p: { phase?: string; tool_call_id?: string; reproduction_key?: string; hypothesis?: string },
	observed: ObservedResult,
	reproduction: Reproduction | null,
): string {
	if (p.phase === "hypothesize" || p.phase === "confirm") {
		return "it carries no hypothesis — put the falsifiable mechanism in the `hypothesis` field";
	}
	if (p.phase === "instrument") {
		return (
			`tool_call_id is the failing baseline ${reproduction?.failingCallID} again — the instrument has to be a ` +
			`distinct run from the reproduction, or it measures nothing new`
		);
	}
	if (!reproduction) return `no reproduction is bound — start again at phase "reproduce"`;
	const faults: string[] = [];
	if (p.reproduction_key !== reproduction.key) {
		faults.push(
			`reproduction_key is ${p.reproduction_key ? `"${p.reproduction_key}"` : "missing"}, and the bound reproduction is "${reproduction.key}"`,
		);
	}
	if (p.tool_call_id === reproduction.failingCallID) {
		faults.push(`tool_call_id is the failing baseline ${reproduction.failingCallID} again — re-verification needs a distinct run`);
	}
	if (observed.family !== reproduction.family) {
		faults.push(`the result came from ${observed.name}, not ${reproduction.toolName} — rerun the tool that reproduced it`);
	}
	if (observed.family === HIVE_RUN_FAMILY && reproduction.family === HIVE_RUN_FAMILY && !sameHiveWorkRerun(reproduction, observed)) {
		if (!reproduction.subject) {
			faults.push(
				"the reproduction was read from task logs, which name no project, pipeline or branch, so no later run can be " +
					"shown to rerun it — bind the reproduction to a run record (get_run / explain_failure) instead",
			);
		} else if (observed.subject !== reproduction.subject) {
			faults.push(`that run is ${observed.subject ?? "unidentified"}, not ${reproduction.subject} — re-verify the same project, pipeline and branch`);
		} else {
			faults.push(`that is the reproduced run ${reproduction.runId} itself — re-verification needs a new run`);
		}
	}
	if (observed.verdict === "failed") faults.push("that run still failed");
	if (observed.verdict === "indeterminate") faults.push("that run reached no verdict (still running, timed out or cancelled)");
	// Unreachable while this list and the bind condition stay in step. Kept
	// because a drifting pair should degrade to the old vague sentence, not to
	// "…, but . Order: …" — a refusal with a hole in it reads as a harness bug
	// and sends the agent looking in the wrong place entirely.
	return faults.length > 0 ? faults.join("; ") : "it does not satisfy re-verification";
}

/** The protocol's position: the state, and the reproduction it is bound to. */
export interface EvidenceMachine {
	phase: ProtocolState;
	reproduction: Reproduction | null;
}

export const INITIAL_EVIDENCE: EvidenceMachine = { phase: "reproduce", reproduction: null };

export interface EvidenceParams {
	phase?: string;
	tool_call_id?: string;
	reproduction_key?: string;
	hypothesis?: string;
}

/**
 * One `bugfix_evidence` call. `stage` is set when the call MOVED the protocol
 * (pi renders it as the bugfix widget); a refusal leaves the machine as it was
 * and carries `stage: null`.
 */
export function applyEvidence(
	machine: EvidenceMachine,
	results: ReadonlyMap<string, ObservedResult>,
	p: EvidenceParams,
	names: BugfixToolNames = PI_BUGFIX_TOOLS,
): { machine: EvidenceMachine; stage: ProtocolState | null; text: string } {
	const { phase, reproduction } = machine;
	const moved = (next: ProtocolState, text: string, bound: Reproduction | null = reproduction) => ({ machine: { phase: next, reproduction: bound }, stage: next, text });
	const refused = (text: string) => ({ machine, stage: null, text });
	if (p.phase === "blocked") return moved("blocked", "Investigation stopped honestly; no edits were unlocked.");
	const observed = p.tool_call_id ? results.get(p.tool_call_id) : undefined;
	// The id lives in the tool-event stream, which the MODEL never sees — so
	// "needs the id" alone described a value the caller had no way to produce.
	// Agents with a live reproduction were refused every time (HIV-3078: 6+
	// blocking papercuts in one week). The refusal hands over the ids it is
	// checking against, newest first, so the next call can succeed.
	if (!observed) return refused(refusalWithCandidates(new Map(results), p.tool_call_id));
	if (p.phase === "reproduce") {
		const key = p.reproduction_key?.trim();
		if (observed.verdict !== "failed" || !key) return refused(reproduceRefusal(p.tool_call_id as string, observed, key));
		const bound: Reproduction = { key, failingCallID: p.tool_call_id as string, toolName: observed.name, family: observed.family, subject: observed.subject, runId: observed.runId };
		return moved("hypothesize", `Reproduction failed via ${observed.name}; state a falsifiable mechanism.`, bound);
	}
	if (p.phase === "hypothesize" && phase === "hypothesize" && p.hypothesis?.trim()) return moved("instrument", "Hypothesis recorded; run an instrument that can distinguish it.");
	if (p.phase === "instrument" && phase === "instrument" && p.tool_call_id !== reproduction?.failingCallID) return moved("confirm", "Instrumentation recorded; confirm the mechanism it established.");
	if (p.phase === "confirm" && phase === "confirm" && p.hypothesis?.trim()) return moved("fix", "Hypothesis confirmed; record the root cause, fix it, then rerun the same reproduction.");
	if (
		p.phase === "reverify" && phase === "fix" && reproduction && p.reproduction_key === reproduction.key &&
		p.tool_call_id !== reproduction.failingCallID && observed.family === reproduction.family && observed.verdict === "passed" &&
		(observed.family !== HIVE_RUN_FAMILY || sameHiveWorkRerun(reproduction, observed))
	) {
		return moved("done", "The same reproduction now passes.");
	}
	// Two questions, answered separately: was this the wrong PHASE, or the
	// right phase with the wrong payload? `?? "(none)"` rather than `!`: a
	// caller reading `Read as phase "undefined"` would hunt a bug in their own
	// arguments instead of an absent one.
	const requested = p.phase ?? "(none)";
	const expected = EXPECTED_CALL[phase];
	if (p.phase !== expected) return refused(orderingRefusal(requested, phase, null, names));
	return refused(orderingRefusal(requested, phase, payloadFault(p, observed, reproduction), names));
}

export interface RootCause {
	summary: string;
	evidence: string;
}

/**
 * One `bugfix_root_cause` call. A recorded cause unlocks edits in bugfix
 * mode; outside the `fix` state it is refused in bugfix mode, and an empty
 * mechanism or evidence is refused always — an empty artifact would unlock
 * the edits while recording nothing, which is the gate defeating itself.
 */
export function applyRootCause(
	mode: OpMode,
	phase: ProtocolState,
	params: { summary?: unknown; evidence?: unknown },
	names: BugfixToolNames = PI_BUGFIX_TOOLS,
): { rootCause: RootCause | null; text: string } {
	const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");
	if (mode === "bugfix" && phase !== "fix") {
		return { rootCause: null, text: `Record reproduce, instrumentation, and a confirmed hypothesis with ${names.evidence} before unlocking edits.` };
	}
	const summary = clean(params.summary);
	const evidence = clean(params.evidence);
	if (!summary || !evidence) return { rootCause: null, text: "A root cause needs both a mechanism and the evidence for it. Nothing was recorded." };
	return {
		rootCause: { summary, evidence },
		text:
			`Root cause recorded — file edits are unlocked.\n\n` +
			`  ${summary}\n  evidence: ${evidence}\n\n` +
			`Fix it, then verify with the same instrument that established the cause.`,
	};
}

/**
 * The evidence a completed tool result contributes, and the id it is bound
 * by. A pulled background job is keyed by its JOB id and carries the JOB's
 * verdict, not the pull's — `background_result` succeeds whatever the job did,
 * and two pulls of one failing job must not look like two runs. Only
 * `background_result` is read this way, so a header-shaped string in another
 * tool's output cannot mint a job id.
 */
export function observeToolResult(
	toolName: string,
	toolCallId: string,
	isError: boolean,
	texts: readonly string[],
	structured?: unknown,
): { key: string; observed: ObservedResult } {
	const full = texts.join("\n");
	const observed = observe(toolName, isError, full, structured, texts[0]);
	const job = toolName === "background_result" ? parseResultHeader(full) : null;
	return job
		? { key: job.id, observed: { ...observed, family: SHELL_FAMILY, verdict: jobVerdict(job.status) } }
		: { key: toolCallId, observed };
}
