/**
 * Watching a Hive run instead of polling it — the pure part.
 *
 * ## Why this lives in `background/`
 *
 * Layering says a Hive tool belongs beside the other Hive extensions. It cannot
 * be: pi builds a fresh jiti instance per extension with `moduleCache: false`,
 * so `background/index.ts`'s job registry is module state that a *different*
 * extension importing it would never see — it would start jobs into its own
 * private map, and nothing would ever reap or report them. A tool that starts a
 * background job has to be registered by the extension that owns the registry.
 *
 * So the hive-specific knowledge is quarantined HERE, as pure functions with no
 * `pi` and no process, and `index.ts` keeps one thin tool that calls them.
 *
 * ## Why the tool exists at all
 *
 * `hive watch <run>` and `background_bash` already compose into exactly the
 * right thing: subscribe to the run's event stream, end when the run ends,
 * report once. Measured 2026-08-17 (HIV-1998), a session that had
 * `background_bash` in its toolset and used it elsewhere still spent eight
 * turns, ~6 minutes and ~23KB of duplicate payload polling `wait_for_run` on
 * one run — because nothing connected the two, and the poll tool's own message
 * told it to keep polling.
 *
 * `background/README.md` explains why the fix is a tool and not a sentence in a
 * prompt: "a required parameter cannot decay over a long session the way a
 * system-prompt instruction measurably does". The same argument that makes
 * `what` a schema field makes this a tool.
 */

import { StringDecoder } from "node:string_decoder";

import { isGateTaskKey } from "../hive-common/gate-tasks.ts";

/**
 * The tool's contract, shared by pi's `hive_watch_run` (background/index.ts)
 * and the Claude adapter's (claude/mcp/watch-run-tool.ts): one wording, so the
 * two harnesses cannot drift into describing different tools.
 */
export const WATCH_RUN_DESCRIPTION =
	"Watch a Hive CI run to completion in the background and return immediately. Use this INSTEAD of " +
	"calling wait_for_run repeatedly: wait_for_run is a request with a timeout, so a run longer than " +
	"that timeout costs you one turn and one full duplicate result per re-call. This is a stream — it " +
	"ends when the run ends, and you are told once, with the run's own verdict. Carry on with " +
	"something else meanwhile; use get_run or explain_failure when you actually need a detail.";

export const WATCH_RUN_GUIDELINE =
	"If you find yourself calling wait_for_run a second time on the same run, stop and use " +
	"hive_watch_run instead — every further re-call costs a turn and a duplicate result for no new information.";

export const WATCH_RUN_PARAMS = {
	run: "The run's UUID, or the #N shown in the Hive UI and in `hive runs`.",
	what:
		"A short human-readable description, e.g. 'waiting for the Borealis ci gate'. " +
		"Shown to the person watching instead of a bare command line.",
	project: "Project, to disambiguate a run NUMBER (numbers are per pipeline).",
	pipeline: "Pipeline, to further disambiguate a run number.",
	timeout_seconds: "Wall-clock limit. Default 1800 (30 min), maximum 14400 (4 h).",
} as const;

export const WATCH_VERDICT_NOTE =
	"The job's own outcome IS the run's verdict — `hive watch` exits with the run's result — so a " +
	"`done` completion means the run passed and `failed` means it did not.";

/** How long a run-number lookup may take before we stop waiting on it. */
const RESOLVE_TIMEOUT_MS = 5_000;

/**
 * One bounded GET, and it never throws.
 *
 * Bounded because this sits in front of starting a job: a hung lookup would
 * turn "return immediately" — the entire point of the tool — into a stall, and
 * a tool that blocks while promising not to is worse than one that fails.
 */
export async function fetchRunJSON(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; body: unknown }> {
	try {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
		let body: unknown = null;
		try {
			body = await res.json();
		} catch {
			/* a non-JSON body is an error body; `ok` already carries the verdict */
		}
		return { ok: res.ok, status: res.status, body };
	} catch {
		return { ok: false, status: 0, body: null };
	}
}

/** A run reference is either the UUID or the `#N` every human-facing surface shows. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRunUUID(ref: string): boolean {
	return UUID_RE.test(ref.trim());
}

/**
 * True for the `#N` form, with or without the `#`.
 *
 * Numbers are allocated PER PIPELINE, so a number alone can be ambiguous —
 * which is why resolution takes project/pipeline and why the error path below
 * hands the candidates back rather than guessing.
 */
export function isRunNumber(ref: string): boolean {
	return /^#?\d+$/.test(ref.trim());
}

export function normalizeRunRef(ref: string): string {
	return ref.trim().replace(/^#/, "");
}

export interface ResolveDeps {
	baseURL: string;
	token: string;
	getJSON: (url: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number; body: unknown }>;
}

/**
 * Resolve a run reference to the UUID `hive watch` needs.
 *
 * A UUID passes through without a round trip. A NUMBER costs one lookup — and
 * has to, because numbers are per-pipeline and the CLI on the box may predate
 * server-side number resolution (`cmd/hive/watch.go` landed 2026-08-16; a
 * workstation binary older than that answers `flag provided but not defined:
 * -project` and then 400s on `GET /runs/<n>`). Resolving here means the command
 * we hand to the shell is always the form every version understands.
 */
export async function resolveRunUUID(
	ref: string,
	project: string | undefined,
	pipeline: string | undefined,
	deps: ResolveDeps,
): Promise<{ uuid: string } | { error: string }> {
	const normalized = normalizeRunRef(ref);
	if (!normalized) return { error: "`run` is empty — pass a run UUID or the #N shown in the Hive UI." };
	if (isRunUUID(normalized)) return { uuid: normalized };
	if (!isRunNumber(normalized)) {
		return { error: `\`run\` must be a run UUID or a run number, got ${JSON.stringify(ref)}.` };
	}

	const params = new URLSearchParams({ query: `#${normalized}` });
	if (project) params.set("project", project);
	if (pipeline) params.set("pipeline", pipeline);
	const res = await deps.getJSON(`${deps.baseURL}/api/v1/runs?${params.toString()}`, {
		Authorization: `Bearer ${deps.token}`,
	});
	if (!res.ok) {
		return { error: `Could not resolve run #${normalized}: Hive answered ${res.status || "unreachable"}.` };
	}

	const runs = extractRuns(res.body).filter((r) => String(r.number) === normalized);
	if (runs.length === 0) {
		// "Narrow it" was the wrong instruction when a filter was already given:
		// the caller passed `project`, the number is not in it, and narrowing
		// further cannot find something the filter is what excluded. Measured
		// 2026-08-18: `No run #2150 in project Borealis-Ops. Run numbers are per
		// pipeline — pass project (and pipeline) to narrow it.` — advice that
		// leads away from the answer.
		//
		// So ask once more WITHOUT the filters. Either the number lives somewhere
		// else and we can say where, or it exists nowhere the caller can see,
		// which is a definite answer rather than a suggestion.
		const elsewhere = project || pipeline ? await findRunElsewhere(normalized, deps) : [];
		if (elsewhere.length > 0) {
			return { error: `No run #${normalized} in ${scopeOf(project, pipeline)}. It exists as ${elsewhere.join(", ")} — pass that, or the run's UUID.` };
		}
		return {
			error:
				`No run #${normalized}${project || pipeline ? ` in ${scopeOf(project, pipeline)}, or in any project you can see` : " in any project you can see"}. ` +
				`Run numbers are per pipeline, so check the number against the UI, or pass the run's UUID.`,
		};
	}
	if (runs.length > 1) {
		// Ambiguity is the caller's to resolve, not ours to guess: watching the
		// wrong run reports the wrong verdict and does it confidently.
		const where = runs.map((r) => `${r.project || "?"}/${r.pipeline || "?"}`).join(", ");
		return {
			error:
				`Run #${normalized} is ambiguous — numbers are per pipeline and it matches ${where}. ` +
				`Pass \`project\` and \`pipeline\`.`,
		};
	}
	return { uuid: runs[0].id };
}

/** "project Borealis-Ops", "pipeline ci", or both — what the caller asked for. */
function scopeOf(project: string | undefined, pipeline: string | undefined): string {
	const parts: string[] = [];
	if (project) parts.push(`project ${project}`);
	if (pipeline) parts.push(`pipeline ${pipeline}`);
	return parts.join(" / ") || "any project";
}

/** How many `project/pipeline` pairs a "it exists as …" line will name. */
const MAX_ELSEWHERE = 3;

/**
 * Where else this run number lives, as `project/pipeline` pairs.
 *
 * Only on the failure path, so the common case still costs one request. Any
 * error here yields an empty list: this is the message-improving half of a
 * refusal, and a refusal must not turn into a different failure because its
 * footnote could not be fetched.
 */
async function findRunElsewhere(number: string, deps: ResolveDeps): Promise<string[]> {
	try {
		const res = await deps.getJSON(`${deps.baseURL}/api/v1/runs?${new URLSearchParams({ query: `#${number}` }).toString()}`, {
			Authorization: `Bearer ${deps.token}`,
		});
		if (!res.ok) return [];
		const rows = extractRuns(res.body).filter((r) => String(r.number) === number);
		const where = [...new Set(rows.map((r) => `${r.project || "?"}/${r.pipeline || "?"}`))];
		if (where.length <= MAX_ELSEWHERE) return where;
		return [...where.slice(0, MAX_ELSEWHERE), `and ${where.length - MAX_ELSEWHERE} more`];
	} catch {
		return [];
	}
}

interface RunRow {
	id: string;
	number?: number;
	project?: string;
	pipeline?: string;
}

/**
 * Read the run list out of whatever shape the endpoint returned.
 *
 * Deliberately tolerant of both a bare array and a `{runs: […]}` envelope: this
 * house has already lost a corpus to parsing an API against its README instead
 * of against production, and a watcher that silently resolves nothing is the
 * same failure wearing a different hat.
 */
function extractRuns(body: unknown): RunRow[] {
	const raw = Array.isArray(body)
		? body
		: typeof body === "object" && body !== null && Array.isArray((body as { runs?: unknown[] }).runs)
			? (body as { runs: unknown[] }).runs
			: [];
	const out: RunRow[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const row = item as Record<string, unknown>;
		if (typeof row.id !== "string") continue;
		out.push({
			id: row.id,
			...(typeof row.number === "number" ? { number: row.number } : {}),
			...(typeof row.project === "string" ? { project: row.project } : {}),
			...(typeof row.pipeline === "string" ? { pipeline: row.pipeline } : {}),
		});
	}
	return out;
}

/**
 * The command a watch job runs.
 *
 * `hive watch` streams the run's SSE feed (full backlog replayed on connect),
 * terminates when the run does, and exits with the run's own result — so the
 * background job's `done`/`failed` status IS the run's verdict, with no extra
 * parsing. The UUID is validated by `resolveRunUUID` before it gets here, so
 * nothing caller-controlled reaches the shell.
 */
export function watchCommand(uuid: string): string {
	if (!isRunUUID(uuid)) throw new Error(`refusing to build a watch command for a non-UUID: ${uuid}`);
	return `hive watch ${uuid}`;
}

/**
 * The first failed gate task in a `hive watch` stream, as soon as it is printed.
 *
 * A PR gate fans out into shards, and the run only ends when the last one does.
 * Measured: a background watch on a gate said nothing for 50 minutes after its
 * `test-2` shard had failed, because the other shards were still queued — the
 * server knew, the agent did not. `hive watch` already prints every event as it
 * arrives (`formatEvent` in hive's internal/hiveclient/sse.go: the type padded
 * to 22 columns, the task key, then `: <reason>` when there is one), and it
 * de-duplicates replays across reconnects, so the stream is enough: no CLI
 * change is needed.
 *
 * A failed TASK, not a failed run: the stream carries only the key, and whether
 * the failure fails the run is the server's call (an allow_failure step, a
 * failure the trunk baseline masks, or one an on_failure fixer repairs does
 * not). The notice says exactly that. `task.retrying` is not a failure at all.
 */
const FAILED_TASK_LINE = /^task\.(failed|timed_out)\s+(\S+?):?(?:\s|$)/;
/** `hive watch`'s last line once the run's terminal frame arrived: `run <state>`. */
const RUN_ENDED_LINE = /^run [a-z_]+$/;

export function failedGateTask(line: string): { key: string; event: string } | null {
	const match = FAILED_TASK_LINE.exec(line.trim());
	if (!match || !isGateTaskKey(match[2])) return null;
	return { key: match[2], event: `task.${match[1]}` };
}

export interface WatchFailureScanner {
	/** Feed a stdout chunk; the first failed gate task not skipped, exactly once. */
	feed(chunk: Buffer): { key: string; event: string; line: string } | null;
	/** True once the stream printed the run's end — a notice would be stale. */
	readonly ended: boolean;
}

/**
 * Scan a watch's stdout. Chunks split lines (and UTF-8 sequences) anywhere, so
 * a partial line waits for its newline. `skip` names failures the agent was
 * already told about (the gate's own result), which are not news.
 */
export function watchFailureScanner(skip: (key: string) => boolean = () => false): WatchFailureScanner {
	const decoder = new StringDecoder("utf8");
	let partial = "";
	let found = false;
	let ended = false;
	return {
		get ended() {
			return ended;
		},
		feed(chunk) {
			const lines = (partial + decoder.write(chunk)).split("\n");
			partial = lines.pop() ?? "";
			let result: { key: string; event: string; line: string } | null = null;
			for (const line of lines) {
				if (RUN_ENDED_LINE.test(line.trim())) ended = true;
				const failed = found ? null : failedGateTask(line);
				if (failed && !skip(failed.key)) {
					found = true;
					result = { ...failed, line: line.trim() };
				}
			}
			return result;
		},
	};
}

/** The early notice: a gate task failed, the run is still going. */
export function firstFailureNotice(o: { id: string; what: string; runID: string; key: string; line: string }): string {
	return (
		`Background watch \`${o.id}\` (${o.what}): task \`${o.key}\` failed while run ${o.runID} is still going.\n` +
		`  ${o.line}\n` +
		"The run was NOT cancelled and the watch continues; its final verdict still arrives when the run ends, and decides " +
		"whether this failure counts (an allow_failure step, a failure the trunk baseline masks, or one an on_failure fixer " +
		`repairs does not). Diagnose \`${o.key}\` now — explain_failure, or get_run_tests with only_unmasked — rather than ` +
		"waiting for the other tasks; do not re-dispatch the gate."
	);
}

export const WATCH_FIRST_FAILURE_NOTE =
	"If a `test`/`lint` task fails while other tasks are still running, you are also told at once, with its task key; " +
	"the run is not cancelled and the final verdict still follows.";

/** A run row as the REST endpoint returns it, narrowed to what a note needs. */
interface RunState {
	state?: string;
	tasks_summary?: { total?: number; succeeded?: number; running?: number; pending?: number; failed?: number };
	started_at?: string;
}

/**
 * What the run was actually doing when the watch gave up.
 *
 * A watch that hits its wall clock reports "no terminal event" and a log tail of
 * `task.ready` — which says nothing about WHY. Measured 2026-08-18: a two-hour
 * watch on PR run #9705 ended with exactly that, on a night when hive runs were
 * waiting 60-90 minutes for capacity. "It never started" and "it started and one
 * step is stuck" want opposite responses, and the tail cannot tell them apart.
 *
 * Bounded and silent on failure: this is a footnote to a timeout, and a footnote
 * that fails must not become the report. Returns "" when it has nothing to add.
 */
export async function runStateNote(runID: string, deps: ResolveDeps): Promise<string> {
	try {
		const res = await deps.getJSON(`${deps.baseURL}/api/v1/runs/${encodeURIComponent(runID)}`, {
			Authorization: `Bearer ${deps.token}`,
		});
		if (!res.ok) return "";
		const body = res.body as { run?: RunState } | RunState | null;
		const run = (body && typeof body === "object" && "run" in body ? body.run : body) as RunState | undefined;
		if (!run) return "";
		const s = run.tasks_summary ?? {};
		const total = s.total ?? 0;
		const done = (s.succeeded ?? 0) + (s.failed ?? 0);
		const running = s.running ?? 0;
		// NEVER STARTED is the case worth naming: nothing was wrong with the run
		// or the watch, it was queued the whole time, and the answer is capacity
		// rather than anything the caller can fix by watching harder.
		if (!run.started_at && running === 0 && done === 0) {
			return (
				`The run had NOT started when the watch gave up: ${total || "?"} task(s), none begun, state ` +
				`${run.state ?? "unknown"}. It was waiting for capacity, not stuck — check the fleet ` +
				`(fleet_status) rather than the run.`
			);
		}
		return (
			`When the watch gave up the run was ${run.state ?? "unknown"}: ${done}/${total || "?"} task(s) finished, ` +
			`${running} running. Re-watch it, or read the detail with get_run.`
		);
	} catch {
		return "";
	}
}
