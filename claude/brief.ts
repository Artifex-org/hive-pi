/**
 * `brief` — hive-pi's opening-prompt brief for a Claude session.
 *
 * The same pass the pi extension runs on `before_agent_start`
 * (`brief/index.ts`): the suppression rules (`detect.ts`), the Hive protocol
 * split, the per-lane retrieval workers with their per-lane wall
 * (`run.ts`/`lanes.ts`), and the budgeted compile (`compile.ts`). The driver
 * calls it once per launch, so "already briefed this session" is the
 * driver's to know, not this command's.
 *
 * The model is the catalog's delegation mode as pi picks it, narrowed to
 * providers the launch leased; with none, the brief does not run (model.ts's
 * rule: never on the session's own model, here Claude's).
 */

import { compileBrief } from "../extensions/brief/compile.ts";
import { loadBriefConfig } from "../extensions/brief/config.ts";
import { splitTeamProtocol, suppressionReason } from "../extensions/brief/detect.ts";
import { runBriefer } from "../extensions/brief/run.ts";
import { hiveAuth, modelUnavailableReason, type AdapterEnv } from "./env.ts";
import { isConfiguredWith, leasedProviders } from "./models.ts";
import { loadPinnedPi } from "./pi-runtime.ts";
import type { Spool } from "./spool.ts";
import { CLAUDE_HELPER_GUIDANCE } from "./guidance.ts";

export type BriefResult = { brief: string } | { brief: null; reason: string };

export async function runBriefCommand(cwd: string, prompt: string, env: AdapterEnv, spool: Spool): Promise<BriefResult> {
	const unavailable = modelUnavailableReason(env);
	if (unavailable) return { brief: null, reason: unavailable };
	const cfg = loadBriefConfig();
	if (cfg.disabled) return { brief: null, reason: "PI_BRIEF_DISABLED=1" };
	const skip = suppressionReason({ prompt, minPromptChars: cfg.minPromptChars, alreadyBriefed: false, env: process.env });
	if (skip) return { brief: null, reason: skip };

	const { task } = splitTeamProtocol(prompt);
	const pi = await loadPinnedPi(env.piBin as string, env.piAgentDir as string);
	const providers = leasedProviders(env.piAgentDir as string);
	const result = await runBriefer({
		task,
		cwd,
		timeoutMs: cfg.timeoutMs,
		model: cfg.model,
		roles: pi.roles,
		modelHost: { auth: hiveAuth(env), isConfigured: isConfiguredWith(providers) },
	});
	for (const lane of result.lanes) {
		if (lane.usage) spool.usage("brief", result.model, lane.usage, lane.elapsedMs, Math.max(1, lane.turns));
	}
	if (!result.draft) return { brief: null, reason: result.failure || "the brief produced no draft" };
	// includeOriginal:false — the prompt this brief accompanies is sent anyway.
	const { text } = compileBrief({
		original: task,
		draft: result.draft,
		budgetTokens: cfg.budgetTokens,
		includeOriginal: false,
		model: result.model,
		elapsedMs: result.elapsedMs,
	});
	return { brief: `${text}\n\n${CLAUDE_HELPER_GUIDANCE}` };
}
