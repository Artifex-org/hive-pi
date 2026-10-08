/**
 * `advisor` — a stronger, independent, CROSS-FAMILY read of the session.
 *
 * pi's advisor (`extensions/advisor/`), with Claude's transcript as input:
 * the Claude JSONL is translated to pi messages (transcript.ts) and serialised
 * by pi's own `serializeConversation`, capped by `capTranscript`, framed by
 * `buildAdvisorPrompt`, and answered by the catalog's advisor choice
 * (`pickConfiguredAdvisor`). Claude's own model is not in pi's catalog, so the
 * caller is UNRANKED — the strongest configured mode answers — and the leased
 * store holds only non-Anthropic providers, so it is always another family.
 *
 * The prompt rides an `@file`, never argv: a 400k-character transcript is far
 * past Linux's 128 KiB per-argument limit.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAdvisorConfig } from "../../extensions/advisor/config.ts";
import { advisorFailureMessage, pickConfiguredAdvisor } from "../../extensions/advisor/modes.ts";
import { buildAdvisorPrompt, capTranscript } from "../../extensions/advisor/prompt.ts";
import { isThinkingLevel } from "../../extensions/hive-remote/status.ts";
import { isConfiguredWith, readCatalog } from "../models.ts";
import type { OneShot } from "../oneshot.ts";
import type { AdapterEnv } from "../env.ts";
import { readClaudeTranscript } from "../transcript.ts";
import type { ToolDefinition, ToolResult } from "./protocol.ts";

export const ADVISOR_TOOL: ToolDefinition = {
	name: "advisor",
	description:
		"Consult a stronger reviewer on a DIFFERENT model family. Takes no parameters: the whole session so far is forwarded. " +
		"Call it before committing to an approach, when stuck, and before declaring work done.",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export interface AdvisorDeps {
	env: AdapterEnv;
	providers: ReadonlySet<string>;
	serializeConversation(messages: readonly unknown[]): string;
	oneShot: OneShot;
	cwd: string;
}

export async function runAdvisor(deps: AdvisorDeps): Promise<ToolResult> {
	const cfg = loadAdvisorConfig();
	if (cfg.disabled) return { text: "advisor is disabled (PI_ADVISOR_DISABLED=1).", isError: true };
	if (!deps.env.transcript) return { text: "advisor: HIVE_CLAUDE_TRANSCRIPT is unset, so there is no session to forward.", isError: true };

	const entries = readClaudeTranscript(deps.env.transcript);
	const lastModel = [...entries].reverse().find((e) => e.message.role === "assistant" && "model" in e.message && e.message.model);
	const currentSpec = lastModel && lastModel.message.role === "assistant" && lastModel.message.model ? `anthropic/${lastModel.message.model}` : "claude-code";
	const { text: transcript } = capTranscript(deps.serializeConversation(entries.map((e) => e.message)), cfg.maxChars);

	let spec: string;
	let thinking: string;
	let note: string | undefined;
	if (cfg.modelOverride) {
		spec = cfg.modelOverride;
		thinking = "high";
	} else {
		const outcome = await readCatalog(deps.env);
		if (outcome.kind === "no-auth") return { text: advisorFailureMessage("no-auth"), isError: true };
		if (outcome.kind !== "ok") return { text: advisorFailureMessage(outcome), isError: true };
		// "" — the caller is unranked by construction: Claude is not a catalog mode.
		const pick = pickConfiguredAdvisor(outcome.catalog.modes, "", isConfiguredWith(deps.providers));
		if (!pick) return { text: advisorFailureMessage("none-configured"), isError: true };
		spec = pick.spec;
		// pi's rule: the catalog's level when it is one; `off` disables reasoning;
		// missing or unrecognised means `high`.
		thinking = isThinkingLevel(pick.thinking) ? pick.thinking : "high";
		note = pick.note;
	}

	const dir = mkdtempSync(join(tmpdir(), "hive-pi-advisor-"));
	try {
		const file = join(dir, "advisor-request.md");
		writeFileSync(file, buildAdvisorPrompt(transcript, currentSpec, spec), { encoding: "utf8", mode: 0o600 });
		const result = await deps.oneShot({
			prompt: "The attached file is your brief and the session to review. Answer as the advisor it describes.",
			promptFiles: [file],
			model: spec,
			thinking,
			cwd: deps.cwd,
			timeoutMs: cfg.timeoutMs,
			env: { PI_AGENDA_WORKER: "1" },
		});
		if (result.timedOut) return { text: `advisor ${spec} did not answer within ${Math.round(cfg.timeoutMs / 1000)}s.`, isError: true };
		if (result.exitCode !== 0) return { text: `advisor ${spec} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(-400)}`, isError: true };
		const advice = result.text.trim();
		if (!advice) return { text: `advisor ${spec} returned an empty answer.`, isError: true };
		// A same-class advisor announces itself AHEAD of its advice.
		return { text: note ? `[advisor note] ${note}\n\n${advice}` : advice };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
