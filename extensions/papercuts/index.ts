/**
 * papercuts — let the agent log friction at the moment it hits it.
 *
 * See ./papercuts.ts for the format and the argument for in-the-moment capture
 * over nightly transcript mining. This file is the wiring: one tool, one
 * command, an append, and a cap.
 *
 * THE ONE MECHANICAL CONSTRAINT, inherited from every extension here: pi awaits
 * handlers serially, so a slow handler IS the agent loop. This extension
 * registers NO event handlers at all — the filesystem work happens inside a TOOL
 * `execute`, which pi runs as the tool call the model asked for, not inside the
 * loop that dispatches it. That is what buys the read-cap-rewrite below the
 * right to be synchronous.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { registerGuardedTool } from "../guards-common/capability.ts";
import { configPathFor, numberOr, readJSON } from "../hive-common/identity.ts";
import {
	capEntries,
	normalizeSeverity,
	parseEntries,
	renderEntry,
	toEntry,
	type Entry,
	type Severity,
} from "./papercuts.ts";

interface PapercutsConfig {
	enabled: boolean;
	/** Log file. `~` expanded; a relative path resolves under ~/.pi/agent. */
	path: string;
	/** Entries kept. Older ones fall off the top. */
	maxEntries: number;
}

/**
 * The wire shape carried in the tool result's `details`.
 *
 * THIS IS THE PART THAT MAKES THE FEATURE REAL FOR A CONTAINERIZED AGENT, and it
 * is worth being explicit about because the markdown file looks like the
 * deliverable and is not. A factory run's container is destroyed when the run
 * ends: a papercuts.md written inside it is gone, along with every observation
 * the most heavily-worked agents on the fleet made. What DOES survive is the
 * session transcript, which is collected and shipped to the Hive agents
 * workspace — so the structured entry has to ride out on the tool result, where
 * collection already looks.
 *
 * `v` is a version tag, not decoration: a consumer on the other side of that
 * collection is deployed separately from this file and will be reading v1 shapes
 * long after this one changes.
 */
export interface PapercutDetails {
	v: 1;
	type: "papercut";
	entry: Entry;
	/**
	 * Why the log file did not receive this entry, when it did not.
	 *
	 * Additive to the v1 shape (absent on the happy path), and it exists so no
	 * surface can claim a write that did not happen. A consumer reading these out
	 * of a transcript needs to know which entries are ALSO on disk somewhere and
	 * which exist only here — so this field means EXACTLY "this entry is
	 * transcript-only", and nothing else may set it.
	 */
	writeError?: string;
	/**
	 * Why the cap could not be applied, when the entry itself was written.
	 *
	 * Separate from `writeError` because the two say opposite things about where
	 * the entry is. Folding a failed trim into `writeError` — which the first
	 * version did — makes every such entry look transcript-only to the consumer
	 * that partitions on it, and makes the transcript line claim a write that in
	 * fact succeeded. The append is never rolled back, so the file is oversized
	 * rather than wrong; a permanently failing trim is visible here.
	 */
	capError?: string;
}

/** How many entries `/papercuts` shows when asked for no number in particular. */
const DEFAULT_SHOW = 10;

/**
 * Defaults ON, and the reasoning is narrate's rather than hive-telemetry's.
 *
 * Telemetry and hive-remote default OFF because they send data off the machine,
 * so consent must be an explicit act. This writes one local file that nobody
 * uploads. The `details` envelope does travel — but only inside a transcript the
 * session was already producing and already shipping, so it discloses nothing
 * the transcript did not.
 */
function loadConfig(): PapercutsConfig {
	const raw = readJSON<Partial<PapercutsConfig>>(configPathFor("papercuts")) ?? {};
	const agentDir = join(homedir(), ".pi", "agent");
	const configured = typeof raw.path === "string" && raw.path.trim() ? raw.path.trim() : "papercuts.md";
	return {
		enabled: raw.enabled !== false,
		path: resolvePath(configured, agentDir),
		// Floor of 10: a cap low enough to lose today's entries turns the log into
		// a scratchpad. Ceiling high enough that nobody hits it by accident.
		maxEntries: numberOr(raw.maxEntries, 500, 10, 100_000),
	};
}

function resolvePath(configured: string, agentDir: string): string {
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return isAbsolute(configured) ? configured : join(agentDir, configured);
}

/**
 * The header written once, when the file is created.
 *
 * The file is meant to be opened by a human who does not remember what wrote it,
 * possibly months later; two lines of provenance at the top cost one write and
 * save that question. `capEntries` preserves the preamble for exactly this.
 */
const FILE_HEADER = [
	"# papercuts",
	"",
	"Friction logged by agents at the moment they hit it, via the `papercut` tool.",
	"Newest entries are at the bottom. Safe to edit or delete by hand.",
	"",
	"",
].join("\n");

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();
	// A disabled install registers NOTHING — not a tool that refuses, not a
	// command that says "disabled". The same reasoning narrate spells out: a
	// registered no-op is worse than an absence, and here it is worse in a second
	// way. A tool the model can see is a tool it will spend tokens deciding
	// about, on every request, forever.
	if (!cfg.enabled) return;

	// registerGuardedTool, not pi.registerTool. This tool writes a file, and the
	// house rule is that guards are NOT inherited: guards-bridge enforces on tool
	// NAME (`bash`, `edit`, `write`), so an undeclared writing tool is ungoverned
	// by default. `test/tool-capability.test.ts` fails on any registered tool that
	// neither declares a capability nor sits on the reviewed read-only list.
	//
	// The path is DERIVED, not a parameter — the model cannot choose where this
	// writes — so the declaration is `writesResolved` returning the one file we
	// will touch. That is not ceremony: `path` is user-configurable, so someone
	// can point the log at a protected worktree, and this is what refuses.
	registerGuardedTool(pi, {
		capability: { writesResolved: () => [cfg.path] },
		name: "papercut",
		label: "Log friction",
		// The description IS the feature. A logging tool nobody calls is a file
		// that stays empty, and the failure mode is not refusal — it is a model
		// that saves the observation for a summary at the end of the task, by
		// which point the specific thing that cost it four minutes has been
		// compressed into "some tooling issues". So: concrete triggers, and an
		// explicit instruction about WHEN, stated twice.
		description: [
			"Record a piece of friction in this environment, AT THE MOMENT YOU HIT IT.",
			"Call it mid-task, before you work around the problem — not at the end, and not as part of a summary.",
			"Log it when: a tool failed in a way whose message did not tell you what to do;",
			"a doc, README or comment said something that turned out to be wrong;",
			"something took four steps that should take one;",
			"a guard or check blocked something reasonable;",
			"you had to guess a name, path or flag that should have been discoverable;",
			"or you found the answer somewhere other than where you first, reasonably, looked.",
			"One papercut per call. Quote the exact command, path or message — a specific complaint gets fixed and a vague one does not.",
			"Do not stop what you were doing: log it and carry on.",
		].join(" "),
		promptSnippet: "Log environment friction the moment you hit it",
		promptGuidelines: [
			"When something in this environment gets in your way — a confusing tool error, a wrong doc, a four-step workflow — call `papercut` right then, then carry on. Do not batch them up for the end of the task.",
		],
		parameters: Type.Object({
			friction: Type.String({
				description:
					"What got in the way, concretely. Quote the exact command, path, or error text. One papercut per call.",
			}),
			context: Type.Optional(
				Type.String({ description: "What you were trying to do when you hit it. One line." }),
			),
			severity: Type.Optional(
				Type.Union([Type.Literal("minor"), Type.Literal("moderate"), Type.Literal("blocking")], {
					description:
						"minor: annoying, cost you nothing. moderate: cost you a detour. blocking: you could not proceed until you worked around it. Defaults to minor.",
				}),
			),
		}),
		renderCall: (args, theme) => {
			const severity: Severity = normalizeSeverity(args.severity);
			return new Text(theme.fg("warning", "✂ papercut ") + theme.fg("dim", severity), 0, 0);
		},
		// Four outcomes, four lines. The transcript line must never claim a write
		// that did not happen — nor deny one that did. The no-entry case is the
		// guard wrapper refusing the call before `execute` ran (it returns
		// `details: {}`); `writeError` reached the transcript but not the disk;
		// `capError` reached the disk but left the file over its cap.
		renderResult: (result, _options, theme) => {
			const details = result.details as PapercutDetails | undefined;
			const entry = details?.entry;
			if (!entry) return new Text(theme.fg("warning", "✂ papercut refused"), 0, 0);
			if (details?.writeError) {
				return new Text(
					theme.fg("warning", `✂ ${entry.severity} · log write failed — entry is in the transcript`),
					0,
					0,
				);
			}
			if (details?.capError) {
				return new Text(
					theme.fg("warning", `✂ ${entry.severity} · logged to ${cfg.path} — cap not applied`),
					0,
					0,
				);
			}
			return new Text(theme.fg("dim", `✂ ${entry.severity} · logged to ${cfg.path}`), 0, 0);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Read off ctx BEFORE any await — ctx goes stale the moment the session
			// is replaced (resume/fork/reload), which is the trap advisor/index.ts
			// and agenda/goal.ts both document. There is no await below, but the
			// ordering is kept so that adding one later cannot introduce the bug.
			const cwd = safeCwd(ctx);
			const entry = toEntry(params, { at: new Date().toISOString(), cwd });

			// Rendered from `entry` rather than from `params`, so the file and the
			// transcript are guaranteed to carry the same record — normalization
			// happens once, above, not once per destination.
			//
			// A write failure must NOT fail the tool call. The agent is mid-task and
			// logged this as an aside; turning a read-only filesystem into a tool
			// error would make the aside the problem — and the `details` envelope
			// carries the entry into the transcript either way, which for a
			// container is the copy that survives anyway. It is RECORDED rather
			// than swallowed: `writeError` below is what stops any surface
			// claiming a write that did not happen.
			//
			// The two failures are kept APART. "The entry never reached the disk"
			// and "the entry reached the disk but the file is still over its cap"
			// are opposite facts about where the record lives, and the consumer
			// that partitions transcript-only entries from on-disk ones acts on
			// exactly that difference.
			const outcome = appendCapped(cfg, renderEntry(entry));
			const details: PapercutDetails = {
				v: 1,
				type: "papercut",
				entry,
				...(outcome.writeError ? { writeError: outcome.writeError } : {}),
				...(outcome.capError ? { capError: outcome.capError } : {}),
			};

			return {
				content: [
					{
						type: "text" as const,
						text: outcome.writeError
							? `Noted (${entry.severity}). The log file could not be written (${outcome.writeError}) — the entry is still in this session's transcript. Carry on.`
							: outcome.capError
								? `Logged (${entry.severity}). The entry is on disk, but the log could not be trimmed to its cap (${outcome.capError}). Carry on.`
								: `Logged (${entry.severity}). Carry on with what you were doing.`,
					},
				],
				details,
			};
		},
	});

	pi.registerCommand("papercuts", {
		description: "Show recently logged friction (papercut entries)",
		handler: async (args: string, cmdCtx: ExtensionCommandContext): Promise<void> => {
			const requested = Number.parseInt(args.trim(), 10);
			const count = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 200) : DEFAULT_SHOW;
			const entries = parseEntries(readOrEmpty(cfg.path));
			if (entries.length === 0) {
				cmdCtx.ui.notify(`No papercuts logged yet.\n${cfg.path}`);
				return;
			}
			const shown = entries.slice(-count);
			const lines = shown.map((entry) => {
				const head = `${entry.at} · ${entry.severity}${entry.context ? ` · ${entry.context}` : ""}`;
				// One line per entry in the list: the friction text can be a pasted
				// stack trace, and a notify that scrolls the terminal off the top is
				// how a summary stops being read. The file is the full record.
				return `${head}\n  ${firstLine(entry.friction)}`;
			});
			cmdCtx.ui.notify(
				[`${shown.length} of ${entries.length} papercuts · ${cfg.path}`, "", ...lines].join("\n"),
			);
		},
	});
}

/** ctx is a Proxy that throws once stale; a command that cannot say where it is
 *  is still better than a tool call that fails. */
function safeCwd(ctx: { cwd?: string } | undefined): string {
	try {
		return ctx?.cwd ?? process.cwd();
	} catch {
		return process.cwd();
	}
}

/**
 * What `appendCapped` reports. The two fields are mutually exclusive and say
 * OPPOSITE things about where the entry ended up.
 */
interface WriteOutcome {
	/** Set only when the entry did NOT reach the file. */
	writeError?: string;
	/** Set only when the entry DID reach the file but the trim failed. */
	capError?: string;
}

/**
 * Append, then cap.
 *
 * Capping on EVERY append rather than every Nth keeps the file self-bounding:
 * it can never hold more than maxEntries + 1, so the read-parse-rewrite is
 * bounded at roughly 100KB and costs a few milliseconds. The one unbounded read
 * is the first append against a file that was already oversized — which is
 * precisely the moment the cap is for. A counter that deferred the trim would
 * trade that bounded cost for an unbounded one at an unpredictable moment.
 *
 * Returns an empty outcome on success. Never throws: see the caller.
 *
 * The two failures are reported SEPARATELY and must stay that way. A failed
 * append means the entry exists only in the transcript; a failed trim means the
 * entry is on disk and the file is merely over its cap. Reporting the second as
 * the first — which the first version did — makes every surface deny a write
 * that succeeded, and misfiles the entry for the consumer that partitions
 * transcript-only records from on-disk ones.
 */
function appendCapped(cfg: PapercutsConfig, rendered: string): WriteOutcome {
	try {
		mkdirSync(dirname(cfg.path), { recursive: true });
		if (!existsSync(cfg.path)) appendFileSync(cfg.path, FILE_HEADER, "utf8");
		appendFileSync(cfg.path, rendered, "utf8");
	} catch (error) {
		return { writeError: reason(error) };
	}
	try {
		const current = readFileSync(cfg.path, "utf8");
		const capped = capEntries(current, cfg.maxEntries);
		// Rewrite only when the cap actually removed something — the common path
		// touches the file once, with an append.
		if (capped !== current) {
			// tmp + rename, so a process killed mid-trim leaves the old complete
			// file rather than a truncated one. identity.ts's atomicWrite is
			// hardcoded to the hive-telemetry state dir, so it cannot be reused for
			// a path the user chose.
			const tmp = `${cfg.path}.tmp`;
			writeFileSync(tmp, capped, "utf8");
			renameSync(tmp, cfg.path);
		}
	} catch (error) {
		// The entry IS on disk; only the trim failed. Reported so a permanently
		// failing trim is visible, but the append is not rolled back — and
		// deliberately NOT as `writeError`, which would deny a write that happened.
		return { capError: reason(error) };
	}
	return {};
}

function readOrEmpty(path: string): string {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : "";
	} catch {
		return "";
	}
}

function reason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, 200);
}

function firstLine(friction: string): string {
	const line = friction.split("\n").find((candidate) => candidate.trim()) ?? "";
	return line.length > 160 ? `${line.slice(0, 157)}…` : line || "(no detail)";
}
