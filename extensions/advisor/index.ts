/**
 * advisor — ask a higher-class model for advice, from inside the session
 * (HIV-1247).
 *
 * A session running a medium/low-class model registers one tool, `advisor`,
 * with NO parameters: calling it forwards the ENTIRE conversation to the model
 * one class above the current one (per the Hive agent-mode catalog — the same
 * ladder the Build workspace's mode selector shows) and returns that model's
 * advice. Zero parameters is the design, not a limitation: the agent cannot
 * cherry-pick what the advisor sees, and the advisor's value is precisely in
 * catching what the agent doesn't know it's missing.
 *
 * The consultation is one plain completion — no tools, no session, no way to
 * recurse. Its token usage is returned as the tool result's `usage`, which pi
 * persists and hive-telemetry folds into the session's own cost.
 *
 * Mirrors the Claude Code harness advisor; the doctrine in the description is
 * deliberately the same (consult before committing to an approach, when stuck,
 * before declaring done).
 */

import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { resolveAuth } from "../hive-common/identity.ts";
import { splitModelSpec } from "../hive-remote/status.ts";
import { loadAdvisorConfig } from "./config.ts";
import { advisorFailureMessage, fetchAgentModeOutcome, pickAdvisorModel, type AdvisorPick } from "./modes.ts";
import { buildAdvisorPrompt, capTranscript } from "./prompt.ts";

/** Answer budget. Advice is prose, not code — 16k tokens is a long memo. */
const ANSWER_MAX_TOKENS = 16_384;

export default function (pi: ExtensionAPI) {
	const cfg = loadAdvisorConfig();
	if (cfg.disabled) return;

	pi.registerTool({
		name: "advisor",
		label: "Advisor",
		promptSnippet: "Consult a stronger model for advice (forwards the full conversation)",
		description: [
			"Consult a stronger reviewer model. Your ENTIRE conversation is forwarded",
			"automatically — task, tool calls, results, reasoning — so the advisor sees",
			"exactly what you have done. Call it BEFORE committing to an approach, when",
			"stuck (recurring errors, results that don't fit, an approach not converging),",
			"and before declaring the task done. Takes no arguments. Give the advice",
			"serious weight; if it conflicts with primary-source evidence you hold, say",
			"so explicitly rather than silently ignoring either side.",
		].join(" "),
		parameters: Type.Object({}),
		async execute(_id, _params, signal, onUpdate, ctx) {
			// Everything read off ctx happens BEFORE the first await: ctx goes
			// stale the moment the session is replaced (resume/fork/reload), and
			// this tool is long-running by nature (agenda/goal.ts documents the
			// same trap).
			const registry = ctx.modelRegistry;
			const currentSpec = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no model selected)";
			const entries = ctx.sessionManager.buildContextEntries();

			const messages = entries
				.filter((e): e is SessionMessageEntry => e.type === "message")
				.map((e) => e.message);
			const serialized = serializeConversation(convertToLlm(messages));
			const { text: transcript, capped } = capTranscript(serialized, cfg.maxChars);

			const pick = await resolveAdvisor(cfg.modelOverride, currentSpec);
			const parts = splitModelSpec(pick.spec);
			if (!parts) throw new Error(`advisor model spec ${JSON.stringify(pick.spec)} is not provider/id`);
			const model = registry.find(parts.provider, parts.id);
			if (!model) {
				throw new Error(
					`advisor model ${pick.spec} is not configured on this machine — ` +
						`add it to pi's models, or set PI_ADVISOR_MODEL to one that is`,
				);
			}
			// Kept as a PRECONDITION even though `registry.complete` resolves auth
			// itself, because the errors are not equally useful: this one names the
			// provider and says the credential is missing on this machine, which is
			// the actual fix. Letting the request fail instead surfaces a provider
			// transport error after the transcript has already been sent.
			const auth = await registry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(`no credential for ${parts.provider} on this machine: ${auth.error}`);

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `consulting ${pick.spec} (${transcript.length.toLocaleString()} chars of conversation)…`,
					},
				],
				details: {},
			});

			const startedAtMs = Date.now();
			// `registry.complete`, NOT `complete()` from `@earendil-works/pi-ai/compat`.
			//
			// That module's own header says it "is deleted with the coding-agent
			// ModelManager migration", and several of its members are already
			// `@deprecated` — scheduled breakage under a tool used daily.
			//
			// HIV-1585 expected this to be a stream refactor, because `complete()`
			// appeared to exist only in `/compat`. It does not: `ModelRegistry`
			// carries the same `complete(model, context, options)` and pi already
			// hands it to every extension on `ctx`. The registry we were ALREADY
			// using for `find()` and `getApiKeyAndHeaders()` could answer the call
			// the whole time.
			//
			// `apiKey`/`headers`/`env` are gone from the options because the
			// registry resolves auth itself — "Models resolves auth and delegates
			// each request to the provider that owns the model". Passing them was
			// the compat surface's requirement, not this call's.
			const response = await registry.complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: buildAdvisorPrompt(transcript, currentSpec, pick.spec) }],
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: ANSWER_MAX_TOKENS,
					cacheRetention: "none",
					// `crypto.randomUUID()`, not pi-ai's `uuidv7`: that symbol is root-exported
					// but UNDOCUMENTED (zero hits across 30 doc files), so it is exactly the
					// kind of dependency an upstream bump removes without it counting as a
					// breaking change. Nothing here depends on v7's time ordering — this is a
					// correlation id for one throwaway completion.
					sessionId: randomUUID(),
					signal: AbortSignal.any([AbortSignal.timeout(cfg.timeoutMs), ...(signal ? [signal] : [])]),
				},
			);

			const advice = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();
			if (!advice) throw new Error(describeEmptyAnswer(pick.spec, response));

			const usage = response.usage;
			return {
				content: [{ type: "text" as const, text: advice }],
				// The consultation's spend, surfaced as this tool result's usage:
				// pi adds it to the session totals and hive-telemetry folds it into
				// the session's cost — the advisor never bills invisibly.
				usage,
				details: {
					advisor_model: pick.spec,
					mode_key: pick.modeKey,
					transcript_chars: transcript.length,
					capped,
					// The browser widget (hive web lib/widgets, HIV-1247): what was
					// consulted, what it read, what it cost — plus the advice itself,
					// bounded, so the widget is self-contained. The generic envelope
					// contract; an older hive renders the plain card unchanged.
					hive_widget: {
						v: 1,
						type: "advisor",
						spec: {
							model: pick.spec,
							mode_key: pick.modeKey,
							status: "done",
							transcript_chars: transcript.length,
							capped,
							tokens_in: usage.input,
							tokens_out: usage.output,
							tokens_reasoning: usage.reasoning,
							total_tokens: usage.totalTokens,
							cost_usd: usage.cost?.total,
							elapsed_ms: Date.now() - startedAtMs,
							advice: advice.length > 8000 ? `${advice.slice(0, 8000)}…` : advice,
						},
					},
				},
			};
		},
	});
}

/**
 * resolveAdvisor: explicit override → Hive mode catalog → a clear error.
 *
 * There is deliberately NO "fall back to the current model" tail: an advisor
 * that silently answers with the same class the agent already has would look
 * like a second opinion while being nothing of the kind. Failing loudly tells
 * the operator which prerequisite (override or Hive auth/catalog) is missing.
 */
async function resolveAdvisor(override: string | undefined, currentSpec: string): Promise<AdvisorPick> {
	if (override) return { spec: override, modeKey: "override" };
	const auth = resolveAuth();
	if (!auth) throw new Error(advisorFailureMessage("no-auth"));

	const outcome = await fetchAgentModeOutcome(auth);
	if (outcome.kind !== "ok") throw new Error(advisorFailureMessage(outcome));

	const pick = pickAdvisorModel(outcome.catalog.modes, currentSpec);
	// The catalog had entries but none usable — every `model` malformed.
	if (!pick) throw new Error(advisorFailureMessage("no-usable-model"));
	return pick;
}


/**
 * describeEmptyAnswer says WHY the advisor produced no prose, instead of only
 * that it did.
 *
 * "returned an empty answer" was 100% of this tool's failures and named no
 * remedy, so every occurrence had to be re-investigated from scratch. The
 * response already carries the answer: a reasoning model that spends its whole
 * budget thinking stops with `length` and a content array of nothing but
 * thinking blocks, which is a budget problem, not an empty reply. A provider
 * error arrives as `error`/`aborted` with an errorMessage. Those three have
 * three different fixes and looked identical from the outside.
 *
 * Token counts and the stop reason only; never any part of the response text.
 * The message reaches a transcript and a telemetry classifier, and the point of
 * the advisor is that it reads a transcript the caller may not want quoted back.
 */
export function describeEmptyAnswer(
	spec: string,
	response: { content: { type: string }[]; stopReason?: string; errorMessage?: string; usage?: { output?: number } },
): string {
	const thought = response.content.some((c) => c.type === "thinking");
	const output = response.usage?.output ?? 0;
	const head = `the advisor (${spec}) returned an empty answer`;

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		// errorMessage is the provider's, about the request — not the transcript.
		const detail = response.errorMessage ? `: ${response.errorMessage}` : "";
		return `${head}: the request ${response.stopReason === "aborted" ? "was aborted" : "failed"}${detail}`;
	}
	if (response.stopReason === "length") {
		return thought
			? `${head}: it hit the ${ANSWER_MAX_TOKENS}-token answer budget while still reasoning (${output} output tokens, no prose). Raise ANSWER_MAX_TOKENS or pick a mode that thinks less.`
			: `${head}: it hit the ${ANSWER_MAX_TOKENS}-token answer budget having emitted no text (${output} output tokens).`;
	}
	if (thought) {
		return `${head}: it produced reasoning and then stopped without writing one (stopReason ${response.stopReason ?? "unknown"}, ${output} output tokens).`;
	}
	return `${head}: no text and no reasoning (stopReason ${response.stopReason ?? "unknown"}, ${output} output tokens) — the model returned nothing at all.`;
}
