/**
 * refs — read a PR, an issue or a merge conflict as if it were a file
 * (HIV-1566). Design notes and the reason this is additive rather than a `read`
 * override live in `schemes.ts`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	commandsFor,
	CONFLICT_STAGES,
	hintForFailedRead,
	looksLikeRef,
	parseRef,
	renderConflict,
	SCHEMES,
} from "./schemes.ts";
import { registerGuardedTool } from "../guards-common/capability.ts";

const run = promisify(execFile);

/** One resolution must not hang a turn. `gh` on a cold auth path is the slow case. */
const TIMEOUT_MS = 30_000;
/** Beyond this the model is better served by a narrower query than a bigger dump. */
const MAX_OUTPUT_BYTES = 200_000;

function text(s: string, isError = false) {
	return { content: [{ type: "text" as const, text: s }], details: {}, ...(isError ? { isError: true } : {}) };
}

async function exec(command: string, args: string[], cwd: string): Promise<{ ok: boolean; text: string }> {
	try {
		const { stdout } = await run(command, args, {
			cwd,
			timeout: TIMEOUT_MS,
			maxBuffer: MAX_OUTPUT_BYTES,
			// No shell: a target reaching a shell is the one way this read-only
			// tool could stop being read-only.
			shell: false,
		});
		return { ok: true, text: stdout };
	} catch (error) {
		const err = error as { stderr?: string; message?: string; code?: string };
		// The underlying command's own error, not a generic string — collapsing a
		// real error into "could not resolve" is a defect class we have paid for.
		const detail = (err.stderr || err.message || String(error)).trim();
		return { ok: false, text: detail };
	}
}

export default function (pi: ExtensionAPI) {
	registerGuardedTool(pi, {
		capability: { executes: true }, // execFile of `gh` / `git show` — read-only by construction, shell:false
		name: "read_ref",
		label: "Read reference",
		promptSnippet: "Read a PR, issue or merge conflict by reference",
		description:
			"Read a reference as text, the way `read` reads a file. Supported: " +
			"`conflict://<path>` — a merge conflict's three stages (base / ours / theirs) as separate " +
			"blocks, instead of hand-parsing <<<<<<< markers out of the working-tree file (an absolute " +
			"path resolves against that file's own worktree — use it when the conflict is not in this cwd); " +
			"`pr://<number>` — a pull request with title, state, body and changed files; " +
			"`issue://<number>` — a GitHub issue (Linear keys are not resolved here; use the Linear MCP tool). " +
			"Read-only. For a merge conflict, list the paths with `git diff --name-only --diff-filter=U` first.",
		parameters: Type.Object({
			ref: Type.String({
				description: "The reference, e.g. conflict://src/foo.ts, pr://1428, issue://HIV-1560",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const parsed = parseRef(params.ref);
			if (parsed.kind === "not-a-ref") {
				return text(
					`\`${params.ref}\` is not a reference. Expected one of ${SCHEMES.map((s) => `${s}://`).join(", ")}. ` +
						"For an ordinary file path, use `read`.",
					true,
				);
			}
			if (parsed.kind === "unknown-scheme") {
				return text(
					`\`${parsed.scheme}://\` is not a scheme this harness resolves. Supported: ${SCHEMES.map((s) => `${s}://`).join(", ")}.`,
					true,
				);
			}

			const resolved = commandsFor(parsed.ref);
			if (resolved.kind === "error") return text(resolved.message, true);

			const outputs: { ok: boolean; text: string }[] = [];
			for (const command of resolved.commands) {
				outputs.push(await exec(command.command, command.args, command.cwd ?? ctx.cwd));
			}

			if (parsed.ref.scheme === "conflict") {
				// Every stage missing means the path is not conflicted HERE — which
				// is a different answer from "the file has no base version", and
				// "here" is the part worth spelling out: three sessions read this
				// error over a real `UU` conflict because the conflict lived in a
				// second worktree while the probes ran in the session's cwd
				// (2026-08-19..21). Name the directory searched, and name the
				// escape — an absolute target resolves against the file's own
				// repository.
				if (outputs.every((o) => !o.ok)) {
					const searched = resolved.commands[0]?.cwd ?? ctx.cwd;
					return text(
						`\`${parsed.ref.target}\` does not look like a conflicted path in \`${searched}\`.\n\n` +
							`git said: ${outputs[0]?.text ?? "(nothing)"}\n\n` +
							"List conflicted paths with `git diff --name-only --diff-filter=U`. If the conflict is in a " +
							"DIFFERENT worktree than this session's cwd, pass the file's absolute path — " +
							"`conflict:///abs/path/to/file` resolves against that file's own repository.",
						true,
					);
				}
				return {
					content: [{ type: "text" as const, text: renderConflict(parsed.ref.target, outputs) }],
					details: {
						hive_widget: {
							v: 1 as const,
							type: "ref" as const,
							spec: {
								scheme: "conflict",
								target: parsed.ref.target,
								stages: CONFLICT_STAGES.map((stage, i) => ({ stage, present: Boolean(outputs[i]?.ok) })),
							},
						},
					},
				};
			}

			const output = outputs[0];
			if (!output.ok) return text(`Could not resolve \`${params.ref}\`:\n\n${output.text}`, true);
			return text(output.text.trim() || "(empty)");
		},
	});

	/**
	 * The hint, in the tool RESULT.
	 *
	 * A model that has learned `read pr://…` from another harness will try it
	 * here, get a confusing ENOENT, and conclude the PR is unreadable. Naming
	 * the right tool at the moment of failure is the placement that works —
	 * the same reasoning as the subagent tool's unknown-agent listing.
	 */
	pi.on("tool_result", (event) => {
		if (event.toolName !== "read" || !event.isError) return;
		const path = (event.input as { path?: unknown; file?: unknown }).path ?? (event.input as { file?: unknown }).file;
		if (!looksLikeRef(path)) return;
		return {
			content: [...event.content, { type: "text" as const, text: hintForFailedRead(String(path)) }],
		};
	});
}
