/**
 * artifacts — the wiring: where the store lives, and how to read it back.
 *
 * `store.ts` owns every rule and every constant; this file owns the two things
 * that cannot be pure — deciding which directory this session's store is, and
 * telling a child process about it. Read `store.ts` first; the reasoning for
 * the numbers is there.
 *
 * ## Three decisions worth knowing before changing anything
 *
 * **1. Nothing here injects.** There is no `before_agent_start` handler, no
 * `sendMessage`, no footer segment. That is not an oversight — it is the whole
 * doctrine of the feature. An artifact exists so that large text does NOT enter
 * context unasked; an extension that announced its own artifacts would be
 * spending the exact budget it was built to protect. Both entry points are
 * tools the model calls when it decides it wants the bytes.
 *
 * **2. The tools register in the factory body, not in `session_start`.** They
 * must exist before the first turn, and a session with no persisted file must
 * still have them. Registration is therefore unconditional and the directory is
 * resolved lazily — a tool called before any spill answers "no artifacts yet"
 * rather than throwing. (It is also what makes the tools visible to
 * `test/tool-capability.test.ts`, which loads every extension and never emits a
 * lifecycle event: registration behind a handler reads to that check as an
 * extension whose tools it cannot see.)
 *
 * **3. An INHERITED `PI_ARTIFACT_DIR` beats this session's own file** — but only
 * one a PARENT PROCESS set. Capturing the variable at factory load is NOT
 * sufficient to tell those apart, which is what the first version of this
 * comment claimed: pi rebuilds extensions on every session replacement, so the
 * factory runs again in the same process and reads back what the previous
 * session exported. `PI_ARTIFACT_DIR_OWNER` carries the exporting pid, so
 * ownership is stated rather than inferred.
 *
 * ## The session file, and what happens when there isn't one
 *
 * pi 0.84 exposes `SessionManager.getSessionFile(): string | undefined`
 * (`dist/core/session-manager.d.ts`), so the store normally sits beside the
 * session jsonl and shares its whole lifecycle. Two cases where it does not:
 * an unpersisted session returns `undefined`, and this repo's `test/fake-pi.ts`
 * does not implement the method at all — so the call is behind a `typeof`
 * check, not a bare invocation. Both land in a per-process directory under
 * `os.tmpdir()`, which works but does not survive the session. Stated in the
 * README under "Where artifacts live".
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGuardedTool } from "../guards-common/capability.ts";
import {
	MAX_ARTIFACTS_PER_SESSION,
	READ_BACK_CAP_BYTES,
	boundForReader,
	headLines,
	listArtifacts,
	parseRef,
	readArtifact,
	refFor,
	adoptDir,
	artifactDirFor,
	newInstanceToken,
	resolveArtifactDir,
	tailLines,
	type ArtifactRecord,
} from "./store.ts";

/** The variable a child pi reads to join its parent's store. */
export const ARTIFACT_DIR_ENV = "PI_ARTIFACT_DIR";

/**
 * Which process exported the path above.
 *
 * Without it "inherited from a parent" and "left behind by my own previous
 * session" are indistinguishable — see the ownership note in the factory.
 */
export const ARTIFACT_DIR_OWNER_ENV = "PI_ARTIFACT_DIR_OWNER";

function text(body: string, isError = false) {
	return { content: [{ type: "text" as const, text: body }], details: {}, ...(isError ? { isError: true } : {}) };
}

/** Compact, human-scale age. An artifact's usefulness decays by the hour. */
export function formatAge(ms: number): string {
	if (ms < 0) return "just now";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The listing the model sees.
 *
 * An index, not a dump: id, kind, size, age, one row each. It exists so the
 * model can find the artifact it half-remembers without reading any of them,
 * which is the cheap half of the whole feature.
 */
export function renderList(records: readonly ArtifactRecord[], nowMs: number): string {
	if (records.length === 0) {
		// Names the ONE producer rather than implying every tool spills. There is
		// exactly one `spill(` call site in the tree today (the kernel), and a
		// model told "large tool output is spilled here automatically" would stop
		// asking for output that was never retained — the store promising a
		// recovery it cannot perform is worse than an empty store.
		return "No artifacts spilled in this session yet. The `kernel` tool spills output above its preview size; other tools do not spill yet.";
	}
	const rows = records.map(
		(record) =>
			`${refFor(record.id)}  ${record.kind}  ${record.bytes} bytes  ${formatAge(nowMs - record.modifiedAtMs)}`,
	);
	const header = `${records.length} artifact(s), cap ${MAX_ARTIFACTS_PER_SESSION}:`;
	return [header, ...rows].join("\n");
}

export default function artifacts(pi: ExtensionAPI) {
	/**
	 * All state lives in this closure. Nothing at module scope: pi builds a
	 * fresh jiti instance per extension with `moduleCache: false`, so a
	 * module-level cache would be per-importer and silently diverge.
	 */
	/**
	 * A dir we inherited from a PARENT process — never one we exported ourselves.
	 *
	 * The first version of this reasoned that capturing `PI_ARTIFACT_DIR` in the
	 * factory, before exporting our own, was enough to tell the two apart. It is
	 * not: pi REBUILDS extensions on every session replacement (`/new`, `/resume`,
	 * a fork all emit session_shutdown, reload, then session_start), so the
	 * factory runs again in the same process and reads back the value the
	 * PREVIOUS session exported. Session two would then adopt session one's store
	 * and quietly append to it — the artifact-store version of the shared-datadir
	 * bug that HIV-1966 fixed one directory over.
	 *
	 * The marker makes ownership explicit rather than inferred: we stamp our pid
	 * next to the path. A value carrying THIS pid was ours, so it is ignored and
	 * the new session resolves its own store; a value with a different pid (or
	 * none) genuinely came from a parent, and joining a parent's store is the
	 * behaviour a child pi wants.
	 */
	const instanceToken = newInstanceToken();
	const ownerEnv = process.env[ARTIFACT_DIR_OWNER_ENV]?.trim();
	const envDir = process.env[ARTIFACT_DIR_ENV]?.trim() || undefined;
	const inheritedDir = envDir && ownerEnv !== String(process.pid) ? envDir : undefined;
	let dir: string | undefined;

	/**
	 * Resolve (once) and publish the directory.
	 *
	 * `mkdir` here rather than at first write so that `PI_ARTIFACT_DIR` always
	 * names a directory that exists — a child process handed a path it then has
	 * to create is a child process that can fail to create it, silently, in a
	 * place nobody is watching.
	 */
	const ensureDir = (ctx?: ExtensionContext): string => {
		if (dir) return dir;
		const resolved = resolveArtifactDir({
			envDir: inheritedDir,
			sessionFile: sessionFileOf(ctx),
			tmpDir: tmpdir(),
			pid: process.pid,
			// Minted per factory run, so the unpersisted-session fallback cannot be
			// shared by two sessions of one process (or two sandboxes that both
			// think they are a low pid).
			instanceToken,
		});
		try {
			mkdirSync(resolved.dir, { recursive: true });
		} catch {
			// A store we cannot create is a store the tools will report as empty.
			// Failing the session over it would be a wildly disproportionate
			// response to "the log directory is read-only".
		}
		dir = resolved.dir;
		// Exported unconditionally, including for the tmpdir fallback: a child
		// sharing an ephemeral store is still strictly better than a child whose
		// artifacts land somewhere its parent will never look.
		process.env[ARTIFACT_DIR_ENV] = dir;
		// Stamped together with the path, so the next factory run in this process
		// can tell our own export from a parent's.
		process.env[ARTIFACT_DIR_OWNER_ENV] = String(process.pid);
		return dir;
	};

	/**
	 * `session_start` is the earliest point a session file exists, so this is
	 * where the store is pinned and exported. It does no I/O beyond one `mkdir`
	 * — pi awaits event handlers serially, so a slow handler IS the agent loop.
	 */
	pi.on("session_start", (event, ctx) => {
		const dir = ensureDir(ctx);
		adoptFromFork(event, dir);
	});

	/**
	 * A fork inherits the REFERENCES, so it has to inherit the BYTES (HIV-1970).
	 *
	 * pi copies custom entries into a fork, and several of those entries carry
	 * `artifact://N` refs — an `/explore` report renders its collected refs
	 * verbatim, for instance. The fork resolves those against its OWN store, so
	 * without this the forked session reads its own history and is told the
	 * artifact does not exist: a transcript that lies to the session holding it.
	 *
	 * `adoptDir` was written and tested for exactly this and had no caller until
	 * now, which is its own lesson — "implemented and tested" is not "wired", and
	 * only a seam audit across components could see the difference.
	 *
	 * Deliberately best-effort and deliberately COPY, not move: the parent may
	 * still be running against its own store, and a fork that fails to inherit
	 * artifacts is worse off than one that never had them, but not broken.
	 */
	function adoptFromFork(event: unknown, target: string): void {
		const reason = (event as { reason?: string } | undefined)?.reason;
		if (reason !== "fork" && reason !== "clone") return;
		const previous = (event as { previousSessionFile?: string } | undefined)?.previousSessionFile;
		if (!previous) return;
		try {
			const from = artifactDirFor(previous);
			if (from === target) return;
			adoptDir(from, target);
		} catch {
			// An unreadable parent store leaves the fork with none — the same place
			// it would have been without this, and never a failed session_start.
		}
	}

	registerGuardedTool(pi, {
		// It reads one file, inside a directory this extension chose, addressed
		// by a numeric id that `parseRef` will not let be a path. Declared rather
		// than allowlisted so the declaration sits next to the tool it describes.
		capability: {
			writesExemptBecause:
				"reads back an artifact this session already spilled; addressed by numeric id only (parseRef rejects paths), writes nothing and spawns nothing",
		},
		name: "artifact_read",
		label: "Read artifact",
		promptSnippet: "Read back the full text behind an artifact:// reference",
		description:
			"Read an artifact spilled earlier in this session, by reference. Large output is written to a " +
			"file and only a short tail is shown inline; this is how you get the rest. Accepts " +
			"`artifact://<id>` or a bare id. With no head/tail, returns the LAST " +
			`${READ_BACK_CAP_BYTES} bytes, because errors and summaries print last. Use \`tail\` to page ` +
			"further into the end, `head` to see how a run started, or both to see each end at once. " +
			"Use `artifact_list` to find an id.",
		parameters: Type.Object({
			ref: Type.String({ description: "The artifact reference, e.g. artifact://7 (or just 7)." }),
			head: Type.Optional(
				Type.Number({ description: "Return only the first N lines. Useful for how a run began." }),
			),
			tail: Type.Optional(
				Type.Number({ description: "Return only the last N lines. Useful for the failure itself." }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Read the ctx before anything else: a ctx goes stale across an await,
			// and this one is only needed to locate the store.
			const store = ensureDir(ctx);
			if (parseRef(params.ref) === null) {
				return text(
					`"${params.ref}" is not an artifact reference. Use artifact://<id> or a bare numeric id; ` +
						"artifact_list shows what this session has.",
					true,
				);
			}
			const body = readArtifact(store, params.ref);
			if (body === null) {
				const known = listArtifacts(store);
				const hint =
					known.length === 0
						? "This session has no artifacts."
						: `This session has ${known.map((record) => refFor(record.id)).join(", ")}.`;
				return text(`No artifact ${params.ref} in this session's store. ${hint}`, true);
			}

			// head/tail select lines; the byte cap still applies afterwards,
			// because "the last 5 lines" of a minified bundle is one enormous
			// line and the cap is what makes this tool's cost predictable.
			let selected = body;
			if (params.head !== undefined && params.tail !== undefined) {
				selected = `${headLines(body, params.head)}\n[…]\n${tailLines(body, params.tail)}`;
			} else if (params.head !== undefined) {
				selected = headLines(body, params.head);
			} else if (params.tail !== undefined) {
				selected = tailLines(body, params.tail);
			}
			return text(boundForReader(selected));
		},
	});

	registerGuardedTool(pi, {
		capability: {
			writesExemptBecause:
				"lists the session's own artifact directory (readdir + stat); writes nothing and spawns nothing",
		},
		name: "artifact_list",
		label: "List artifacts",
		promptSnippet: "List what this session has spilled to artifacts",
		description:
			"List the artifacts this session has spilled: reference, kind, size and age, one row each. " +
			"Cheap — it reads no artifact bodies. Use it to find the id for `artifact_read` when a " +
			"reference has scrolled out of view or been compacted away.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const store = ensureDir(ctx);
			return text(renderList(listArtifacts(store), Date.now()));
		},
	});
}

/**
 * The session's jsonl path, if pi will tell us.
 *
 * Behind a `typeof` check because the method is real in pi 0.84 but absent from
 * `test/fake-pi.ts`, and behind a try/catch because a stale ctx throws on EVERY
 * property access — the documented failure mode for anything holding a ctx.
 * Either way the answer is `undefined` and the caller falls back to tmpdir.
 */
function sessionFileOf(ctx: ExtensionContext | undefined): string | undefined {
	if (!ctx) return undefined;
	try {
		const manager = ctx.sessionManager as unknown as { getSessionFile?: () => string | undefined };
		if (typeof manager?.getSessionFile !== "function") return undefined;
		return manager.getSessionFile() ?? undefined;
	} catch {
		return undefined;
	}
}
