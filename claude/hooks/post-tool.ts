/**
 * PostToolUse — format the file an edit just wrote, with the formatter the
 * repo declares (`format-on-edit`'s `planFor` + `formatFile`, unchanged).
 *
 * pi runs the formatter inside its per-file mutation queue because pi runs a
 * turn's tool calls in parallel; Claude Code's PostToolUse hook runs after the
 * tool has finished, so the formatter runs directly.
 *
 * A configured formatter with no local install is said ONCE per session per
 * config (pi's rule) — the "told" set lives in the state dir because every
 * hook is a fresh process.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { disabled, planFor, realProbe } from "../../extensions/format-on-edit/detect.ts";
import { formatFile } from "../../extensions/format-on-edit/run.ts";
import { CLAUDE_BUGFIX_TOOLS } from "../bugfix.ts";
import { readJson, writeJsonAtomic } from "../state.ts";
import { additionalContext, type HookInput, type HookOutput } from "./io.ts";

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

/**
 * While a bugfix investigation is live (`bugfixLive`), every result is tagged
 * with the id `bugfix_evidence` binds — pi's `evidenceTag`: the model cannot
 * see tool-call ids otherwise, and every phase began with a deliberately
 * refused call just to list them. Claude only runs PostToolUse for SUCCESSFUL
 * calls; a failed run's id is listed by the evidence tool's refusal instead.
 */
export async function postToolDecision(input: HookInput, stateDir: string | null, bugfixLive = false): Promise<HookOutput> {
	const notes: string[] = [];
	const name = input.tool_name ?? "";
	if (bugfixLive && input.tool_use_id && name !== CLAUDE_BUGFIX_TOOLS.evidence && name !== CLAUDE_BUGFIX_TOOLS.rootCause) {
		notes.push(`[bugfix evidence id: ${input.tool_use_id}]`);
	}
	const formatted = await formatNote(input, stateDir);
	if (formatted) notes.push(formatted);
	return notes.length > 0 ? additionalContext("PostToolUse", notes.join("\n")) : null;
}

async function formatNote(input: HookInput, stateDir: string | null): Promise<string | null> {
	if (disabled(process.env)) return null;
	if (!EDIT_TOOLS.has(input.tool_name ?? "")) return null;
	const raw = input.tool_input?.file_path;
	if (typeof raw !== "string" || !raw) return null;
	const requested = isAbsolute(raw) ? raw : resolve(input.cwd ?? process.cwd(), raw);
	let file: string;
	try {
		// The REAL path decides which repo's formatter applies.
		file = realpathSync(requested);
	} catch {
		return null; // the edit reported success but the path is gone; nothing to format
	}

	const plan = planFor(file, realProbe);
	if (plan.kind === "none") return null;
	if (plan.kind === "missing") {
		if (!stateDir) return `[format-on-edit] Not formatted: ${plan.reason}.`;
		const path = join(stateDir, "format-told.json");
		const told = readJson(path);
		const keys = Array.isArray(told) ? told.filter((k): k is string => typeof k === "string") : [];
		if (keys.includes(plan.key)) return null;
		writeJsonAtomic(path, [...keys, plan.key]);
		return `[format-on-edit] Not formatted: ${plan.reason}.`;
	}
	const { note } = await formatFile(file, plan);
	return note;
}
