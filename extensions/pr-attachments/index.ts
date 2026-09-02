/**
 * pr-attachments (HIV-3240) — nudge agents to capture BEFORE/AFTER screenshots
 * and attach them to their PR with gh 2.99's `--attach` flag.
 *
 * Two nudges, both NON-BLOCKING (see logic.ts's header for why hints, not a
 * guard):
 *
 *   a. BEFORE nudge — on the first `edit`/`write` of a session that touches a
 *      UI-visible file, when no screenshot has been taken yet, remind the agent
 *      to take the `before` shot now, because it cannot be taken after the edit
 *      lands. Fires at most once per session.
 *
 *   b. PR nudge — on a `bash`/`background_bash` running `gh pr|issue
 *      create|edit|comment` WITHOUT `--attach`, when the session has
 *      screenshots, inject the exact `--attach '<file>#<alt>'` lines. Fires once
 *      per command shape, so a retry does not repeat it.
 *
 * A gh version gate probes `gh --version` once per session (`/usr/bin/gh` first,
 * then `gh` — the mise shim is dead read-only in the sandbox, per the
 * gh-unauthenticated toolhint) and only suggests `--attach` when >= 2.99.0.
 * Below that, the nudge says to post without images and list the paths.
 *
 * The manifest that feeds these nudges is written by extensions/browser after
 * every screenshot; its file contract is documented in ./manifest.ts.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendHint } from "../toolhints/index.ts";
import { ScreenshotLedger } from "./manifest.ts";
import {
	type GhVersion,
	beforeNudge,
	commandShapeKey,
	ghAttachlessSegment,
	isUIVisiblePath,
	parseGhVersion,
	prNudge,
	versionAtLeast,
} from "./logic.ts";

const NOTE_TAG = "harness";
const SHELL_TOOLS = new Set(["bash", "background_bash"]);

/** Off switch, matching toolhints' PI_TOOLHINTS convention. */
function disabled(env: Record<string, string | undefined>): boolean {
	return env.PI_PR_ATTACHMENTS === "0";
}

/**
 * Probe the installed gh version, `/usr/bin/gh` first then `gh` on PATH.
 *
 * Injectable for tests. In the sandbox the mise `gh` shim fails read-only, so
 * the real binary at `/usr/bin/gh` is the one that answers; parseGhVersion
 * tolerates a shim banner prepended to the output.
 */
export type VersionProbe = () => GhVersion | null;

export const realVersionProbe: VersionProbe = () => {
	for (const bin of ["/usr/bin/gh", "gh"]) {
		try {
			const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5_000 });
			if (res.status === 0) {
				const parsed = parseGhVersion(res.stdout ?? "");
				if (parsed) return parsed;
			}
		} catch {
			// try the next candidate
		}
	}
	return null;
};

export interface WiringOptions {
	probe?: VersionProbe;
	ledger?: ScreenshotLedger;
}

export default function (pi: ExtensionAPI, options: WiringOptions = {}) {
	if (disabled(process.env)) return;

	const ledger = options.ledger ?? new ScreenshotLedger();
	const probe = options.probe ?? realVersionProbe;

	let beforeNudged = false;
	// gh version is probed lazily on the first PR-shaped command and cached for
	// the session \u2014 one spawn, and only if a PR is actually being opened.
	let ghVersion: GhVersion | null = null;
	let ghProbed = false;
	const nudgedShapes = new Set<string>();

	// A note queued in tool_call and delivered on the matching tool_result,
	// mirroring guards-bridge: the decision happens before the tool runs, the
	// only place to say it is after.
	let pending: string | null = null;

	pi.on("session_start", (event) => {
		if (event.reason === "startup" || event.reason === "new") {
			beforeNudged = false;
			ghProbed = false;
			ghVersion = null;
			nudgedShapes.clear();
		}
	});

	pi.on("tool_call", (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			if (beforeNudged) return;
			const input = event.input as { path?: string; file_path?: string };
			const target = input.path ?? input.file_path;
			if (!isUIVisiblePath(target)) return;
			if (ledger.all().length > 0) return; // a shot already exists \u2014 too late to nudge
			beforeNudged = true;
			pending = beforeNudge();
			return;
		}

		if (SHELL_TOOLS.has(event.toolName)) {
			const input = event.input as { command?: string };
			const segment = ghAttachlessSegment(input.command);
			if (!segment) return;
			const records = ledger.all();
			if (records.length === 0) return; // nothing to attach
			const shape = commandShapeKey(segment);
			if (nudgedShapes.has(shape)) return;
			nudgedShapes.add(shape);
			if (!ghProbed) {
				ghVersion = probe();
				ghProbed = true;
			}
			const tooOld = !versionAtLeast(ghVersion);
			pending = prNudge(records, { tooOld, version: ghVersion });
			return;
		}
	});

	pi.on("tool_result", (event) => {
		const note = pending;
		pending = null;
		if (!note) return;
		return { content: appendHint(event.content, `\n\n[${NOTE_TAG} \u00b7 pr-attachments] ${note}`) };
	});
}
