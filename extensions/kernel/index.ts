/**
 * kernel — a persistent Python interpreter, as ONE tool among many (HIV-1968).
 *
 * ## This reverses a standing house decision, and only this far
 *
 * "Persistent kernels — not adopted" was the right call for what was proposed
 * then: a kernel as the PRIMARY action surface, with file edits, search and
 * delegation all routed through `exec`. That trades a reviewed, guarded,
 * diffable tool set for a Python string, and it puts the harness's own guards
 * (the worktree guard, the LSP-backed edit path, the subagent trust gate) behind
 * an interpreter that knows nothing about them.
 *
 * What is adopted here is the scoped version: a kernel is one tool, it edits
 * nothing on the harness's behalf, and every existing path stays exactly where
 * it is. Two things it buys that nothing else here does:
 *
 * 1. **Code execution as a tool call.** Write a script, run it, read a summary.
 *    The intermediate results — the dataframe, the 4,000-row query, the parsed
 *    log — never enter the transcript at all.
 * 2. **Variables that survive turns AND compaction.** The process is not in the
 *    context window, so a 300MB object costs nothing to keep and the agent
 *    slices it programmatically instead of pasting it and re-reading it.
 *
 * Claim 1 depends entirely on the output discipline below. Without the spill,
 * every byte the cell prints is billed to the context on the way past and the
 * token argument for a kernel does not hold — it becomes an expensive `bash`.
 *
 * ## The guard seam, stated because it is not obvious
 *
 * `guards-bridge` matches a SET of shell tools and reads their `command`
 * parameter. This tool's parameter is `code`, and the bridged hook
 * (`pre-bash-dispatch.sh`) is a command-string matcher — handing it a Python
 * cell would produce confident nonsense, and adding `kernel` to `SHELL_TOOLS`
 * would have it read a `command` that does not exist and silently allow
 * everything. So the bash policy path deliberately does NOT apply here. What
 * does apply is the capability declaration (`executes: true`, visible to
 * `test/tool-capability.test.ts`) and the sandbox boundary the session already
 * runs inside. `extensions/kernel/README.md` says the same thing at more length,
 * because a reader looking for "which guard covers this" must not have to infer
 * the answer from an absence.
 *
 * ## Lifetime
 *
 * One kernel per (session, cwd, interpreter); spawned detached so it outlives
 * the turn; reaped on `session_shutdown`, which is the only thing that reaps it.
 */

import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { parseRef, resolveArtifactDir, sanitizeKind, spill } from "../artifacts/store.ts";
import { registerGuardedTool } from "../guards-common/capability.ts";
import {
	KERNEL_PREVIEW_BYTES,
	PREVIEW_LINE_CHARS,
	PREVIEW_LINES,
	renderBody,
	renderToolText,
	resolveTimeoutSeconds,
	shapeOutput,
} from "./protocol.ts";
import { KernelPool, allowedEnv, installHint, kernelKey, resolveInterpreter } from "./session.ts";

const RUNNER = path.join(import.meta.dirname, "runner.py");

/** The artifact `kind`, which becomes the file extension: `<id>.kernel.log`. */
const ARTIFACT_KIND = "kernel";

function textResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
}

export default function kernel(pi: ExtensionAPI) {
	/**
	 * Where spilled output lands. Cached after the first call, because the answer
	 * cannot change within a process and re-deriving it per cell would let a
	 * mid-session `PI_ARTIFACT_DIR` change split one session's artifacts across
	 * two directories.
	 *
	 * The ORDER is the store's, not ours — `resolveArtifactDir` owns it and
	 * documents why an inherited `PI_ARTIFACT_DIR` beats this session's own file.
	 * Reimplementing it here is exactly the drift the shared module exists to
	 * prevent.
	 */
	let artifactDir: string | null = null;
	const dirFor = (sessionFile: string | undefined): string => {
		if (!artifactDir) {
			artifactDir = resolveArtifactDir({
				envDir: process.env.PI_ARTIFACT_DIR,
				sessionFile,
				tmpDir: os.tmpdir(),
				pid: process.pid,
			}).dir;
		}
		return artifactDir;
	};

	/**
	 * The pool lives in this closure, never at module scope: pi builds a fresh
	 * jiti instance per extension with `moduleCache: false`, so a module-level
	 * pool would be a second, invisible set of processes that nothing reaps.
	 */
	const pool = new KernelPool(RUNNER, () =>
		allowedEnv(process.env, {
			// PI_* is on the allowlist, so telling the kernel where artifacts go
			// costs nothing extra and is the contract's own child-adoption path:
			// a pi the cell itself launches inherits this and writes to the same
			// store rather than starting a second one.
			PI_ARTIFACT_DIR: dirFor(undefined),
		}),
	);

	// Not optional. The kernel is spawned detached precisely so the turn's abort
	// cannot kill it, which means nothing else will.
	pi.on("session_shutdown", () => pool.disposeAll());

	registerGuardedTool(pi, {
		name: "kernel",
		label: "Kernel",
		description:
			"Run Python in a persistent interpreter. Variables, imports and loaded data survive between calls " +
			"and across compaction, so load a dataset once and slice it in later calls instead of pasting it " +
			"into the conversation. Only a short preview of the output comes back; the rest is written to an " +
			"artifact you can read or, better, narrow down with another cell. " +
			"Magics: %pip install, %cd, !shell-command, and %%bash as the first line of a cell. " +
			"This is for computing and inspecting — keep editing files, searching and delegating on their own tools.",
		promptSnippet:
			"kernel: persistent Python; variables survive turns and compaction, output is previewed and spilled",
		promptGuidelines: [
			"When you are about to read a large file, parse a log or work through structured data, load it in the " +
				"kernel and print only what you need. Pulling the whole thing into the conversation to reason over " +
				"it is the expensive way to do the same work.",
			"Keep intermediate results in kernel variables between calls rather than re-deriving or re-pasting them.",
			"Do not use the kernel to edit files, search the tree or run the project's own build — those have tools " +
				"that are guarded, reviewed and better at it.",
		],
		/**
		 * A kernel is ONE interpreter and cells share one namespace, so two cells
		 * running at once is not a speed-up — it is two halves of a program
		 * interleaved in a single global scope. pi's default lets tool calls batch
		 * in parallel, so saying so is required rather than decorative. `Kernel`
		 * refuses a second concurrent cell as well: this is a request to a
		 * scheduler, not a guarantee from one.
		 */
		executionMode: "sequential",
		parameters: Type.Object({
			code: Type.String({
				description:
					"Python source to execute in the persistent namespace. A magic (%pip, %cd, !cmd) must be " +
					"the WHOLE cell; %%bash must be its first line. Mixing a magic with Python in one cell is a " +
					"syntax error.",
			}),
			timeout_seconds: Type.Optional(
				Type.Number({ description: "Wall-clock limit for this cell. Default 30, clamped to 1..3600." }),
			),
			reset: Type.Optional(
				Type.Boolean({
					description:
						"Discard the interpreter and start a fresh one before running this cell. Clears every " +
						"variable, import and %cd.",
				}),
			),
		}),
		/**
		 * `executes` is the honest declaration: this spawns a process and the code
		 * it runs can do anything that process can, writing included. There is no
		 * path parameter to guard — `writes` names parameters, and a Python cell
		 * has none — so the exemption says that rather than leaving the field
		 * empty, which `test/tool-capability.test.ts` rejects for good reason.
		 */
		capability: {
			executes: true,
			writesExemptBecause:
				"the cell body has no path parameter to guard; scope is the process's own, as for the bash tool",
		},
		execute: async (_id, params, signal, _onUpdate, ctx) => {
			// Every ctx property read BEFORE the first await: a ctx goes stale
			// across one, and then every access throws.
			const cwd = ctx.cwd;
			const sessionId = ctx.sessionManager.getSessionId?.() ?? "session";
			const sessionFile = ctx.sessionManager.getSessionFile?.();
			// Resolved BEFORE `pool.acquire`, which is what makes the cached
			// directory the one handed to the kernel's own PI_ARTIFACT_DIR.
			const dir = dirFor(sessionFile);

			const interpreter = resolveInterpreter();
			if (!interpreter) return textResult(installHint(), true);

			const timeout = resolveTimeoutSeconds(params.timeout_seconds);
			const key = kernelKey(sessionId, cwd, interpreter.path);
			const live = pool.acquire(key, interpreter, cwd, params.reset === true);

			const { exec, spawned } = await live.execute(params.code, timeout, signal);

			const body = renderBody(exec);
			const shaped = shapeOutput(body, {
				maxLines: PREVIEW_LINES,
				maxLineChars: PREVIEW_LINE_CHARS,
				maxBytes: KERNEL_PREVIEW_BYTES,
			});

			// `spill` is asked for the artifact ONLY once the preview is known to
			// be partial, and with previewBytes 0 so it always writes. The shaping
			// decision is this extension's (lines and line width, not just bytes);
			// the storing decision is the artifact module's. Splitting them that
			// way is what keeps "300 short lines" from counting as a small output.
			let ref: string | null = null;
			let artifactPath: string | null = null;
			if (!shaped.complete) {
				try {
					const stored = spill(body, { dir, kind: ARTIFACT_KIND, previewBytes: 0 });
					ref = stored.ref;
					const id = ref === null ? null : parseRef(ref);
					if (id !== null) artifactPath = path.join(dir, `${id}.${sanitizeKind(ARTIFACT_KIND)}.log`);
				} catch {
					// A full disk or an unwritable session dir must not swallow the
					// cell's result. The preview is still returned; only the "rest is
					// over there" promise is dropped, and dropping a promise we cannot
					// keep beats making one we cannot.
					ref = null;
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: renderToolText({
							exec,
							shaped,
							ref,
							artifactPath,
							interpreter: `${interpreter.path} (${interpreter.origin})`,
							cwd,
							spawned,
						}),
					},
				],
				details: {
					count: exec.count,
					status: exec.status,
					artifact: ref,
					interpreter: interpreter.path,
					interpreter_origin: interpreter.origin,
				},
				isError: exec.status === "error" || exec.status === "crashed",
			};
		},
	});
}
