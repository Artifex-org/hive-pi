/**
 * compaction — Codex-style server-side compaction for OpenAI models (HIV-1886).
 *
 * OFF BY DEFAULT, and the only extension in this package whose default is a
 * privacy posture rather than a preference. Enabling it sends conversation
 * context to OpenAI with `store: true`, which means OpenAI retains it
 * server-side. That is a decision for the operator, made in `/toggles`, and
 * nothing here runs until it is made — the factory returns before registering a
 * single handler.
 *
 * See `support.ts` for the technique, the published numbers and their large
 * caveats, and the safety model.
 *
 * WHAT IS AND IS NOT VERIFIED. Everything except the HTTP round trip is unit
 * tested. The round trip is not, and cannot be here: exercising it means
 * sending real conversation data to OpenAI, which is the exact act this
 * extension exists to gate. First real enable is therefore the first live test
 * — which is why every failure path below degrades to "pi's own summary,
 * unchanged" and says so, rather than throwing into the compaction path.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

import { configPathFor, numberOr, readJSON } from "../hive-common/identity.ts";
import {
	INERT_REASON,
	apiKeyFromCredential,
	buildCompactionRequest,
	canReplay,
	extractCompaction,
	supportFor,
	supportReason,
	type ModelRef,
	type RemoteCompaction,
	type WireMessage,
} from "./support.ts";

const ENDPOINT = "https://api.openai.com/v1/responses";

export interface CompactionConfig {
	enabled: boolean;
	includeAzure: boolean;
	/** Milliseconds before we give up and leave pi's summary as the only artifact. */
	timeoutMs: number;
	/** Recent user messages retained alongside the artifact. */
	keepRecent: number;
}

function loadConfig(): CompactionConfig {
	const raw = readJSON<Partial<CompactionConfig>>(configPathFor("compaction")) ?? {};
	return {
		// `=== true`, never `!== false`. The opt-in shape, matching hive-telemetry
		// and hive-remote — the other two that send data off the machine.
		enabled: raw.enabled === true,
		includeAzure: raw.includeAzure === true,
		timeoutMs: numberOr(raw.timeoutMs, 30_000, 1_000, 120_000),
		keepRecent: numberOr(raw.keepRecent, 4, 0, 50),
	};
}

/**
 * Structural rather than `ExtensionContext`, because both the event context and
 * the command context carry `model` and only that field is wanted here. Typing
 * the parameter to what is actually used avoids the cast between the two that
 * the first draft reached for — `as unknown as` is banned in this package for
 * exactly the reason it was tempting: it would have silenced a real difference
 * between the two context types rather than expressing that we do not care.
 */
function modelOf(ctx: { model?: { provider: string; id: string } | null }): ModelRef | null {
	const model = ctx.model;
	return model ? { provider: model.provider, id: model.id } : null;
}

/**
 * The API key. Env first, then pi's auth store.
 *
 * Read ONCE, in the factory, and held in a closure rather than re-read per
 * compaction — so the value the extension can use is fixed at load time and a
 * later `/toggles` toggle cannot hand a running session a key it did not
 * start with. It is NOT removed from `process.env`, and an earlier version of
 * this comment claimed it was: `$OPENAI_API_KEY` is how pi's own openai
 * provider authenticates, so deleting it here would break model auth for the
 * whole session to protect nothing (any tool with `bash` can read the env of
 * its own child processes regardless).
 *
 * `readStoredCredential` is pi's own reader, which is the point: it knows
 * auth.json's real shape and it resolves the agent dir the way pi does
 * (`$PI_CODING_AGENT_DIR`, then `~/.pi/agent`). The hand-rolled
 * `${HOME}/.pi/agent/auth.json` it replaces read the wrong file entirely for
 * anyone who moves their agent dir, and the wrong FIELD for everyone else —
 * see `apiKeyFromCredential` for that, and for why the value still has to be
 * vetted after it comes back.
 */
function readApiKey(): string | null {
	const fromEnv = process.env.OPENAI_API_KEY;
	if (fromEnv) return fromEnv;
	return apiKeyFromCredential(readStoredCredential("openai"));
}

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();
	wireCompaction(pi, cfg, cfg.enabled ? readApiKey() : null);
}

/**
 * Exported so tests can drive the real factory with a synthetic config instead
 * of whatever happens to be in the developer's ~/.pi — the `wireSkillScope`
 * idiom. It matters more here than anywhere else in this package: the single
 * most important property of this extension is that a disabled config registers
 * NOTHING, and asserting that against the developer's own machine state would
 * be a test that passes for the wrong reason.
 */
export function wireCompaction(pi: ExtensionAPI, cfg: CompactionConfig, apiKey: string | null): void {
	// Disabled means NOTHING registered — no handlers, no command, no network
	// code reachable. Same reasoning as narrate/index.ts: a no-op handler still
	// turns on the path it hangs from, and here that path touches a secret.
	if (!cfg.enabled) return;

	/** Live continuation state. Cleared aggressively — see CLEAR_ON_EVENTS. */
	let artifact: RemoteCompaction | null = null;
	let lastError: string | null = null;
	let lastOutcome = "no compaction yet this session";
	/**
	 * Set the moment the structural gap is hit, so `/compaction` reports the
	 * REASON and not just the symptom. See `INERT_REASON`: "no messages" reads
	 * like bad luck on one boundary, and it is in fact every boundary, forever,
	 * in this build.
	 */
	let inert = false;

	// Registered one by one rather than looped: `pi.on` is overloaded per event
	// name, so a union-typed loop variable does not typecheck (measured — it
	// collapses to the last overload, `"input"`). The verbose form is also the
	// honest one, because each of these is a distinct reason the server's view
	// of the conversation stops matching ours.
	const clear = (): void => {
		artifact = null;
	};
	pi.on("session_start", clear);
	pi.on("session_before_fork", clear);
	pi.on("session_before_switch", clear);
	pi.on("session_before_tree", clear);
	pi.on("session_tree", clear);
	pi.on("model_select", clear);
	pi.on("session_shutdown", clear);

	pi.on("session_compact", async (event, ctx) => {
		// Fires AFTER pi has produced its own portable summary, which is the
		// ordering we want: the text artifact already exists and is untouched by
		// anything below. Everything here is additive or it is nothing.
		const model = modelOf(ctx);
		const level = supportFor(model, cfg.includeAzure);
		if (level !== "direct" || !model) {
			lastOutcome = supportReason(level);
			artifact = null;
			return;
		}
		if (!apiKey) {
			lastOutcome = "no OPENAI_API_KEY — pi's own summary is used";
			return;
		}

		const previous = artifact;
		artifact = null; // a compaction boundary always invalidates the old one

		// STRUCTURALLY ALWAYS EMPTY on pi 0.84.1 — `CompactionEntry` has no
		// `messages` field. Left as-is on purpose rather than repointed at a
		// source that does have them: see `INERT_REASON`. Sending without a
		// replay path is a cost with no benefit, and that is the operator's call
		// to make, not this handler's.
		let messages: WireMessage[] = [];
		try {
			const entry = event.compactionEntry as { messages?: unknown } | undefined;
			if (Array.isArray(entry?.messages)) messages = entry.messages as WireMessage[];
		} catch {
			/* shape drift — fall through to the empty-message guard below */
		}
		if (messages.length === 0) {
			inert = true;
			lastOutcome = INERT_REASON;
			return;
		}

		const body = buildCompactionRequest({
			model: model.id,
			messages,
			systemPrompt: ctx.getSystemPrompt?.(),
		});

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
		try {
			const response = await fetch(ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok) {
				lastError = `HTTP ${response.status}`;
				lastOutcome = `compaction request failed (${lastError}) — pi's own summary is used`;
				return;
			}
			const parsed = extractCompaction(await response.json(), model, Date.now());
			if (!parsed) {
				lastOutcome = "response carried no compaction item — pi's own summary is used";
				return;
			}
			// Only now is the new artifact live, and only for this exact model.
			artifact = canReplay(parsed, model) ? parsed : null;
			lastError = null;
			lastOutcome = artifact ? "server-side artifact stored" : "artifact rejected as cross-model";
		} catch (error) {
			// Including the abort. A compaction that fails must never surface as a
			// broken session — pi already has a working summary at this point.
			lastError = error instanceof Error ? error.message : String(error);
			lastOutcome = `compaction request errored (${lastError}) — pi's own summary is used`;
		} finally {
			clearTimeout(timer);
			if (previous && !artifact) {
				/* previous is deliberately not restored: it predates this boundary */
			}
		}
	});

	pi.registerCommand("compaction", {
		description: "Show server-side compaction status",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const model = modelOf(ctx);
			const level = supportFor(model, cfg.includeAzure);
			ctx.ui.notify(
				[
					`enabled:  true (⚠ store:true — OpenAI retains conversation data)`,
					`model:    ${model ? `${model.provider}/${model.id}` : "none"}`,
					`support:  ${supportReason(level)}`,
					`api key:  ${apiKey ? "present" : "MISSING — no key in $OPENAI_API_KEY or auth.json"}`,
					`artifact: ${artifact ? "live" : "none"}`,
					`last:     ${lastOutcome}`,
					lastError ? `error:    ${lastError}` : "",
					// Always shown once hit, not only as `last:` — the operator opted
					// in and is owed the reason the switch does nothing, in the one
					// place they will look for it.
					inert ? `⚠ INERT:  ${INERT_REASON}` : "",
					"",
					"turn off with: /toggles compaction off",
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		},
	});
}
