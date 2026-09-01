/**
 * `session_grep` — let a session ask what earlier sessions in this directory did.
 *
 * ## Why this exists
 *
 * The handoff seed (HIV-1231) TELLS a successor what the previous session was
 * doing. That is a fixed budget written at handoff time, so it necessarily
 * drops things — and once it has, the successor has no way to recover them. It
 * can be told; it cannot ask. This is the asking half, and it is what makes a
 * deliberately thin seed safe.
 *
 * ## Why it is nearly free
 *
 * pi ALREADY reads every transcript in a cwd: `SessionManager.list()` streams
 * each JSONL and concatenates its user+assistant text into
 * `SessionInfo.allMessagesText` (`session-manager.js:440-511`), which is what
 * the `/resume` picker's fuzzy-and-`re:` search runs over. Nothing exposed it
 * to the model. So this is a wrapper, not a scanner: no index, no embeddings,
 * no vector store — the house position on file-based memory, and the cheapest
 * thing that can be visibly wrong.
 *
 * ## Four deliberate limits
 *
 * 1. **This cwd only.** `listAll()` would materialise EVERY transcript on the
 *    machine — `allMessagesText` is each session's entire text, and there are
 *    ~1000 cwd directories here — with no way to bound it before loading,
 *    because the loading is the API. `list(cwd)` is tens of sessions. The
 *    primary consumer is a handoff successor in the same directory anyway.
 * 2. **The current session is excluded.** Not hygiene — correctness. The
 *    model's own query text lands in this session's transcript BEFORE the tool
 *    runs, so without the filter every search would match its own invocation.
 * 3. **Main session only.** This is not in `WORKER_EXTENSIONS`, so a worker
 *    never gets it. Local JSONL is UNREDACTED — `secretscan` runs on Hive
 *    ingest, not on the file — which makes this the most sensitive local
 *    corpus the harness can read. Narrow grant, same argument knowledge-tools
 *    makes for not handing every role the `mcp` proxy.
 * 4. **Recency-capped**, with the skipped count reported, so an empty result
 *    can never be read as "this was never tried".
 */

import { Type } from "typebox";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { compilePattern, DEFAULTS, renderOutcome, searchSessions, type SessionInfoLike } from "./search.ts";

/** A worker must not get this; belt to `WORKER_EXTENSIONS`' braces. */
const IS_WORKER = process.env.PI_AGENDA_WORKER === "1";

function text(s: string, isError = false) {
	return { content: [{ type: "text" as const, text: s }], details: {}, ...(isError ? { isError: true } : {}) };
}

export default function (pi: ExtensionAPI) {
	if (IS_WORKER) return;

	pi.registerTool({
		name: "session_grep",
		label: "Search past sessions",
		promptSnippet: "Regex over the transcripts of past sessions in this directory",
		description:
			"Case-insensitive regex over what was SAID in your earlier sessions in this working directory — " +
			"the user's prompts and your own replies. Use it to recover context a handoff seed did not carry: " +
			"what was already tried, what an earlier session decided, why an approach was abandoned. " +
			"Prefer it over re-deriving from the repo when the question is 'did we already do this'. " +
			"Scope is narrow and worth knowing: this directory only, the newest sessions only, the current " +
			"session excluded. It cannot see other directories, other machines, or anything Hive holds — " +
			"so an empty result means 'not found in this directory's recent history', never 'never happened'.",
		parameters: Type.Object({
			pattern: Type.String({
				description: "Regular expression, case-insensitive. An exact token beats a sentence.",
			}),
			limit: Type.Optional(
				Type.Number({ description: `Max sessions to report (default ${DEFAULTS.limit})` }),
			),
		}),
		execute: async (
			_id: string,
			params: { pattern: string; limit?: number },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) => {
			const compiled = compilePattern(params.pattern);
			if ("error" in compiled) return text(`session_grep: ${compiled.error}`, true);

			let cwd: string;
			let sessionDir: string | undefined;
			let currentFile: string | undefined;
			try {
				const manager = ctx.sessionManager;
				cwd = manager.getCwd();
				sessionDir = manager.getSessionDir();
				// `getSessionFile()` is `string | undefined` on a non-persisted
				// session, and test/fake-pi.ts does not implement it at all — so the
				// call sits behind a typeof check rather than being made bare, the
				// same guard `extensions/artifacts` documents for this method.
				currentFile =
					typeof manager.getSessionFile === "function" ? (manager.getSessionFile() ?? undefined) : undefined;
			} catch {
				return text("session_grep: the session is no longer readable.", true);
			}

			let infos: SessionInfoLike[];
			try {
				infos = (await SessionManager.list(cwd, sessionDir)) as SessionInfoLike[];
			} catch (err) {
				return text(`session_grep: could not list past sessions: ${String(err)}`, true);
			}

			// See limit (2). The exclusion is `searchSessions`' own contract, not a
			// filter applied here — a caller that forgot it would silently report
			// the model's own query back as a finding. When the current file is
			// unknown we cannot exclude it, and the result says so.
			const outcome = searchSessions(infos, compiled, { limit: params.limit, excludePath: currentFile });
			return text(renderOutcome(outcome, params.pattern, cwd, { currentExcluded: Boolean(currentFile) }));
		},
	});
}
