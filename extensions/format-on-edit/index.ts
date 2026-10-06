/**
 * format-on-edit — format the file an edit just wrote, with the formatter the
 * repo declares (HIV-3817).
 *
 * Without this, formatting reaches the agent in one of two expensive ways: it
 * spends a turn running the formatter itself, or the pre-commit hook rewrites
 * the file and the commit fails — after which the agent's picture of the file
 * is wrong in exactly the lines it last touched.
 *
 * What it does, per successful `edit`/`write`:
 *   1. ask `detect.ts` which formatter THIS repo declares for THIS file — a
 *      config plus a project-local binary, never one imposed;
 *   2. run it on that one file, bounded by a timeout;
 *   3. tell the model when the file changed (its next anchor may be stale) or
 *      when the formatter failed. Otherwise say nothing.
 *
 * A configured formatter with no local install is said ONCE per session per
 * config, not on every edit — the note is information, and repeating it would
 * make it noise the model learns to skip.
 *
 * Opt out with `PI_FORMAT_ON_EDIT=0`, read in the factory so a disabled
 * install registers no handler: a no-op `tool_result` handler is still awaited
 * after every tool call in the session.
 */

import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { planFor, type Probe } from "./detect.ts";
import { formatFile } from "./run.ts";

/** The built-in tools whose `path` argument is a file they just wrote. */
const WRITE_TOOLS = new Set(["edit", "write"]);

export function disabled(env: Record<string, string | undefined>): boolean {
	return env.PI_FORMAT_ON_EDIT === "0";
}

/** The real filesystem, for `detect.ts`. */
export const realProbe: Probe = {
	read(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	},
	exists(path) {
		return existsSync(path);
	},
	which(name) {
		for (const dir of (process.env.PATH ?? "").split(delimiter)) {
			if (!dir) continue;
			const candidate = join(dir, name);
			try {
				accessSync(candidate, constants.X_OK);
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				/* not here, or not runnable */
			}
		}
		return null;
	},
};

export default function (pi: ExtensionAPI) {
	if (disabled(process.env)) return;

	/** `missing` notes already given this session, by config. */
	const told = new Set<string>();

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || !WRITE_TOOLS.has(event.toolName)) return;
		const raw = event.input.path;
		if (typeof raw !== "string" || !raw) return;
		const requested = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
		// The REAL path decides which repo's formatter applies: a symlink in one
		// repo pointing into another is that other repo's file.
		let file: string;
		try {
			file = realpathSync(requested);
		} catch {
			return; // the edit reported success but the path is gone; nothing to format
		}

		const plan = planFor(file, realProbe);
		if (plan.kind === "none") return;
		if (plan.kind === "missing") {
			if (told.has(plan.key)) return;
			told.add(plan.key);
			return {
				content: [...event.content, { type: "text" as const, text: `[format-on-edit] Not formatted: ${plan.reason}.` }],
			};
		}

		// Inside pi's per-file mutation queue, the one its own edit/write and
		// pretty-tools' read take. pi runs a turn's tool calls in parallel, and
		// this hook runs after `edit` has released the queue — so without it a
		// same-file read or edit in that batch could see the file truncated
		// mid-format, or have its write overwritten by the formatter's.
		const { note } = await withFileMutationQueue(file, () => formatFile(file, plan));
		if (!note) return;
		return { content: [...event.content, { type: "text" as const, text: note }] };
	});
}
