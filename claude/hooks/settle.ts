/**
 * Stop (ASYNC) — what pi does after every settle without touching the turn:
 * You Should Know, then the agent-status recap. Claude runs this hook with
 * `async: true`; it never blocks the agent and never prints a decision.
 *
 * YSK reuses the extension's pieces whole: the scanner prompt and note
 * parser (`scan.ts`), evidence redaction and grounding (`evidence.ts`), and
 * hive-remote's findings transport with its recording policy
 * (`YouShouldKnowFindingsTransport`, `findingsRequest`). The rate limits are
 * pi's: at least 30 s between scans, at most 20 per session. What differs is
 * WHERE the prose comes from — the Claude transcript, read from a byte cursor
 * — and how the model is reached: a `pi` one-shot child instead of pi's
 * in-process stream.
 *
 * The recap is agenda's: `mechanicalTaskState` for the state, the recap
 * prompt and sanitiser for the one line, POSTed to the session's `/activity`
 * with the body hive-remote sends (`phase`, `since`, `recap`).
 */

import { join } from "node:path";
import { extractJsonObject } from "../../extensions/agenda/verdict.ts";
import { buildRecapPrompt, mechanicalTaskState, MIN_TRANSCRIPT_CHARS, recapTranscript, sanitizeRecap, type TaskState } from "../../extensions/agenda/recap.ts";
import type { HiveAuth } from "../../extensions/hive-common/http.ts";
import { classifyHandback } from "../../extensions/hive-common/handback.ts";
import { YouShouldKnowFindingsTransport } from "../../extensions/hive-common/you-should-know-findings.ts";
import type { ActivityPayload } from "../../extensions/hive-remote/activity.ts";
import { postActivity } from "../../extensions/hive-remote/client.ts";
import { findingsRequest } from "../../extensions/hive-remote/you-should-know.ts";
import { assistantEvidence, groundNotes, redactEvidence, type CaptureSource } from "../../extensions/you-should-know/evidence.ts";
import { DEFAULT_CONFIG as YSK_LIMITS, excerpt, fingerprint, parseNotes, SCAN_SYSTEM } from "../../extensions/you-should-know/scan.ts";
import { readGoal } from "../agenda-state.ts";
import type { ModelResolution } from "../models.ts";
import type { OneShot } from "../oneshot.ts";
import type { SessionResolution } from "../session.ts";
import { readJson, tryLock, writeJsonAtomic, type Control } from "../state.ts";
import { readAppendedLines, readClaudeTranscript, toPiEntries, type PiEntry } from "../transcript.ts";
import type { HookInput } from "./io.ts";

/** The recap's one-shot timeout — agenda/index.ts's. */
const RECAP_TIMEOUT_MS = 60_000;
/** How many sources one scan carries — the extension's buffer. */
const MAX_SOURCES = 20;
/** Quotes passed back as "already surfaced" — the extension's window. */
const SEEN_WINDOW = 25;

export interface SettleDeps {
	stateDir: string;
	control: Control;
	auth: HiveAuth | null;
	/** The server session id, resolved lazily (only when something will be posted). */
	session(): Promise<SessionResolution>;
	resolveYskModel(): Promise<ModelResolution>;
	resolveEvaluator(): Promise<ModelResolution>;
	/** Accounted spawners by role (oneshot.ts). */
	oneShot(role: "ysk" | "recap"): OneShot;
	transcriptPath?: string;
	stderr(line: string): void;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

interface YskState {
	/** Byte offset of the first transcript line not yet scanned. */
	offset: number;
	scans: number;
	lastStart: number;
	/** Fingerprints of quotes already surfaced. */
	seen: string[];
}

function readYskState(stateDir: string): YskState {
	const raw = readJson(join(stateDir, "ysk.json")) as Partial<YskState> | undefined;
	return {
		offset: Number.isSafeInteger(raw?.offset) && (raw?.offset as number) >= 0 ? (raw?.offset as number) : 0,
		scans: Number.isSafeInteger(raw?.scans) && (raw?.scans as number) >= 0 ? (raw?.scans as number) : 0,
		lastStart: typeof raw?.lastStart === "number" && Number.isFinite(raw.lastStart) ? raw.lastStart : 0,
		seen: Array.isArray(raw?.seen) ? raw.seen.filter((q): q is string => typeof q === "string").slice(-100) : [],
	};
}

/** Finalised assistant prose since the cursor, one evidence item per message. */
export function assistantSources(entries: readonly PiEntry[]): CaptureSource["evidence"][] {
	const out: CaptureSource["evidence"][] = [];
	for (const entry of entries) {
		const message = entry.message;
		if (message.role !== "assistant" || !entry.id) continue;
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;
		const text = message.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
		if (text.trim()) out.push(assistantEvidence(entry.id, text));
	}
	return out;
}

export async function runYouShouldKnow(input: HookInput, deps: SettleDeps): Promise<void> {
	if (!deps.control.ysk.enabled) return;
	const path = input.transcript_path || deps.transcriptPath;
	if (!path) {
		deps.stderr("hive-pi: you-should-know skipped — no transcript path");
		return;
	}
	const release = tryLock(join(deps.stateDir, "ysk.lock"));
	// Another settle's scan is waiting or running; it reads the transcript when
	// it starts, so this settle's prose is either in it or left for the next.
	if (!release) return;
	try {
		const now = deps.now ?? Date.now;
		const state = readYskState(deps.stateDir);
		if (state.scans >= YSK_LIMITS.maxScans) return;
		const wait = state.lastStart + YSK_LIMITS.intervalMs - now();
		if (wait > 0) await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);

		const read = readAppendedLines(path, state.offset);
		const evidence = assistantSources(toPiEntries(read.lines));
		if (evidence.length === 0) {
			writeJsonAtomic(join(deps.stateDir, "ysk.json"), { ...state, offset: read.next });
			return;
		}
		const session = await deps.session();
		if (!session.ok) {
			// Not attached yet: leave the cursor where it is, so this prose is
			// scanned once there is somewhere to send what it finds.
			deps.stderr(`hive-pi: you-should-know skipped this settle — ${session.reason}`);
			return;
		}
		if (!deps.auth) return;

		const transport = new YouShouldKnowFindingsTransport({ sessionId: session.id, request: findingsRequest(deps.auth), allowed: () => true });
		await transport.discover();
		// The driver's recording control, applied the way hive-remote applies a
		// remote record_on/record_off: a policy at a revision, accepted only when
		// it is not older than the server's.
		const { recording, recordingRevision } = deps.control.ysk;
		if (recording !== undefined && recordingRevision !== undefined) {
			transport.applyRemotePolicy({ version: 1, recording, recording_revision: recordingRevision });
		}
		const policy = transport.state.capability;
		const scanRecording = policy?.recording === true;
		const revision = policy?.recording_revision ?? 0;

		const captured: CaptureSource[] = evidence.slice(-MAX_SOURCES).map((e) => ({ evidence: { ...e, text: excerpt(e.text) }, recording: scanRecording, revision, serverSessionId: session.id }));
		const source = excerpt(captured.map((c) => c.evidence.text).join("\n\n"));

		const startedAt = now();
		const next: YskState = { ...state, offset: read.next, scans: state.scans + 1, lastStart: startedAt };
		writeJsonAtomic(join(deps.stateDir, "ysk.json"), next);

		const model = await deps.resolveYskModel();
		if (!model.ok) {
			deps.stderr(`hive-pi: you-should-know scan failed — no low model: ${model.reason}; this excerpt was not checked`);
			return;
		}
		const result = await deps.oneShot("ysk")({
			prompt: JSON.stringify({ assistant_output: redactEvidence(source), previously_surfaced_quotes: state.seen.slice(-SEEN_WINDOW).map((q) => redactEvidence(q)) }),
			appendSystemPrompt: SCAN_SYSTEM,
			model: model.pick.spec,
			thinking: "off",
			cwd: input.cwd || process.cwd(),
			timeoutMs: YSK_LIMITS.timeoutMs,
			env: { PI_AGENDA_WORKER: "1" },
		});
		if (result.timedOut || result.exitCode !== 0) {
			deps.stderr(`hive-pi: you-should-know scan failed (${result.timedOut ? "timed out" : `exit ${result.exitCode}`}); this excerpt was not checked`);
			return;
		}
		// A one-shot child answers through pi's print mode, where a model may
		// fence its JSON; the agenda's verdict extractor takes a bare object or
		// one fenced block and refuses anything looser.
		const answer = extractJsonObject(result.text);
		if (answer === null) {
			deps.stderr("hive-pi: you-should-know scan failed: scanner returned no JSON object; this excerpt was not checked");
			return;
		}
		const extracted = parseNotes(answer, source);
		const { notes, findings } = groundNotes(extracted, state.seen, captured, input.session_id ?? session.id, (origin) => origin.recording && scanRecording);
		writeJsonAtomic(join(deps.stateDir, "ysk.json"), { ...next, seen: [...state.seen, ...notes.map((n) => fingerprint(n.quote))].slice(-100) });
		if (findings.length === 0) return;
		transport.capture(findings);
		await transport.upload();
		for (const [, failure] of transport.state.failures) deps.stderr(`hive-pi: you-should-know findings: ${failure}`);
	} finally {
		release();
	}
}

export async function runRecap(input: HookInput, deps: SettleDeps): Promise<void> {
	const path = input.transcript_path || deps.transcriptPath;
	if (!path) {
		deps.stderr("hive-pi: recap skipped — no transcript path");
		return;
	}
	const entries = readClaudeTranscript(path);
	const goal = readGoal(deps.stateDir);
	const taskState: TaskState = mechanicalTaskState({
		asksQuestion: classifyHandback(entries).kind === "human",
		goalAchieved: goal?.state === "achieved",
		goalBlocked: goal?.state === "blocked_user",
		conductorDone: false,
	});
	const session = await deps.session();
	if (!session.ok || !deps.auth) {
		deps.stderr(`hive-pi: status recap not posted this settle — ${session.ok ? "no Hive auth" : session.reason}`);
		return;
	}

	const transcript = recapTranscript(entries);
	const tailPath = join(deps.stateDir, "recap.json");
	const lastTail = (readJson(tailPath) as { tail?: unknown } | undefined)?.tail;
	let recap = "";
	const release = transcript.length >= MIN_TRANSCRIPT_CHARS && transcript !== lastTail ? tryLock(join(deps.stateDir, "recap.lock")) : null;
	// No recap while another settle's is in flight, or when the tail has not
	// changed — the STATE is still news, and an empty recap never blanks the
	// stored one (the server preserves it).
	if (release) {
		try {
			writeJsonAtomic(tailPath, { tail: transcript });
			const model = await deps.resolveEvaluator();
			if (!model.ok) deps.stderr(`hive-pi: recap line skipped — no evaluator model: ${model.reason}`);
			else {
				const result = await deps.oneShot("recap")({
					prompt: buildRecapPrompt(transcript),
					model: model.pick.spec,
					thinking: "off",
					cwd: input.cwd || process.cwd(),
					timeoutMs: RECAP_TIMEOUT_MS,
					env: { PI_AGENDA_WORKER: "1" },
				});
				if (result.exitCode === 0 && !result.timedOut) recap = sanitizeRecap(result.text);
				else deps.stderr(`hive-pi: recap line failed (${result.timedOut ? "timed out" : `exit ${result.exitCode}`})`);
			}
		} finally {
			release();
		}
	}

	const payload: ActivityPayload = {
		phase: taskState === "idle" ? "idle" : taskState,
		since: new Date((deps.now ?? Date.now)()).toISOString(),
		...(recap ? { recap } : {}),
	};
	const posted = await postActivity(deps.auth, session.id, payload);
	if (!posted.ok) deps.stderr(`hive-pi: status recap POST failed (${posted.status ?? "no response"}${posted.error ? `: ${posted.error}` : ""})`);
}
