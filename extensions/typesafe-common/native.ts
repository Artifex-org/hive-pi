/** Agenda's pi-native classifier transport. Standalone evals use client.ts.
 * Credentials, provider routing and prices belong to pi's registry, not here.
 */
import type { ClassifierApi, ClassifierModel, ClassifierQuestion } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { redact, withTimeout } from "../hive-common/http.ts";
import {
	decodeEnvelope, validateRequest,
	type AnswersFor, type ClassifierClient, type JevState, type Outcome, type Question,
} from "./client.ts";
import { DEFAULT_ENDPOINT, type TypesafeConfig } from "./config.ts";

export interface ClassifierRegistry {
	findOfType(type: "classifier", provider: string, id: string): ClassifierModel<ClassifierApi> | undefined;
	classify: ExtensionContext["modelRegistry"]["classify"];
}

export function nativeClassifier(config: TypesafeConfig, registry: () => ClassifierRegistry | null): ClassifierClient {
	return {
		get live() {
			return config.enabled && registry()?.findOfType("classifier", config.provider, config.model) !== undefined;
		},
		async ask<QS extends Record<string, Question>>(state: JevState, questions: QS): Promise<Outcome<AnswersFor<QS>>> {
			if (!config.enabled) return { kind: "disabled", reason: "config" };
			// Custom endpoints must be configured on the native provider. Never
			// silently send a formerly proxy-bound transcript to the default host.
			if (config.endpoint !== DEFAULT_ENDPOINT) {
				return { kind: "rejected", reason: "configure custom endpoints in pi models.json" };
			}
			const models = registry();
			const model = models?.findOfType("classifier", config.provider, config.model);
			if (!models || !model) return { kind: "disabled", reason: "no_model" };
			const refusal = validateRequest(state, questions);
			if (refusal) return { kind: "rejected", reason: refusal };
			const nativeQuestions: Record<string, ClassifierQuestion> = {};
			for (const [key, q] of Object.entries(questions)) {
				const instructions = typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);
				nativeQuestions[key] = q.type === "noul"
					? { type: "bool", instructions, criteria: q.criteria ?? { true: "true", false: "false" } }
					: q.type === "choice"
						? { type: "choice", instructions, criteria: { ...q.criteria } }
						: { type: "score", instructions, criteria: [...q.criteria] };
			}
			const started = Date.now();
			try {
				const result = await withTimeout(config.timeoutMs, (signal) => models.classify(model, {
					state: { data: typeof state === "string" ? state : JSON.stringify(state) }, questions: nativeQuestions,
				}, { signal }));
				if (result.stopReason === "aborted") return { kind: "timeout", timeoutMs: config.timeoutMs };
				// The SDK exposes no structured HTTP status/Retry-After. Do not
				// fabricate them by parsing error prose (which can contain secrets).
				if (result.stopReason !== "stop") return { kind: "transport_error", error: "native_classifier_error" };
				const answers = Object.fromEntries(Object.entries(result.answers).map(([key, answer]) => [key,
					answer.type === "bool" ? { type: "noul", noul: answer.probability } : answer,
				]));
				const decoded = decodeEnvelope({ answers, model: result.model, usage: {
					input_tokens: result.usage?.input, output_tokens: result.usage?.output,
				} }, questions);
				if (!decoded.ok) return { kind: "malformed", reason: decoded.reason, latencyMs: Date.now() - started };
				return { kind: "ok", answers: decoded.value.answers as AnswersFor<QS>,
					usage: { ...decoded.value.usage, ...(result.usage ? { cost: result.usage.cost } : {}) },
					model: decoded.value.model, latencyMs: Date.now() - started };
			} catch (error) {
				return redact(error) === "timeout" ? { kind: "timeout", timeoutMs: config.timeoutMs }
					: { kind: "transport_error", error: redact(error) };
			}
		},
	};
}
