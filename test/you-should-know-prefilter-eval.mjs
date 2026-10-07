// Explicit opt-in, synthetic-only paired evaluation. Never run by CI.
// Max 24 Jev + 24 catalog-low calls, sequential pairs, NO retries.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../extensions/typesafe-common/config.ts";
import { readApiKey } from "../extensions/typesafe-common/key.ts";
import { createJevPrefilter } from "../extensions/you-should-know/prefilter.ts";
import { redactEvidence } from "../extensions/you-should-know/evidence.ts";
import { scanOutput, resolveYouShouldKnowModel } from "../extensions/you-should-know/index.ts";
import { parseNotes } from "../extensions/you-should-know/scan.ts";
import { PREFILTER_CORPUS } from "./you-should-know-prefilter-corpus.ts";

if (process.env.PI_YOU_SHOULD_KNOW_PREFILTER_EVAL !== "1") throw new Error("Set PI_YOU_SHOULD_KNOW_PREFILTER_EVAL=1 to authorize up to 24 Jev and 24 low-model calls over synthetic data only.");
if (PREFILTER_CORPUS.length > 24) throw new Error("Corpus exceeds authorized quota cap.");
const key = readApiKey(); if (!key) throw new Error("No Jev credential; live evaluation NOT RUN.");
// Explicit eval invocation is consent for THIS process only; no config file is changed.
const config = { ...loadConfig(), enabled: true };
const prefilter = createJevPrefilter(config, key, true);
const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
const ctx = { modelRegistry: new ModelRegistry(runtime) };
const model = await resolveYouShouldKnowModel(ctx);
// Pin the resolved low model for this replay; never select the main-session model.
process.env.PI_YOU_SHOULD_KNOW_MODEL = `${model.provider}/${model.id}`;
console.log(JSON.stringify({ quota: { maxJevCalls: 24, maxExtractionCalls: 24, maxExtractionAnswerTokens: 49152, retries: 0 }, jevModel: config.model, timeoutMs: config.timeoutMs, extractionModel: process.env.PI_YOU_SHOULD_KNOW_MODEL, sharedConfigModified: false }));
const rows = [];
for (const fixture of PREFILTER_CORPUS) {
	const safe = { ...fixture, source: redactEvidence(fixture.source, [key]) };
	// Begin Jev before the baseline but do not delay the baseline for it.
	const shadowPromise = prefilter(safe);
	const started = performance.now();
	let extraction = { checked: false };
	try {
		const response = await scanOutput(ctx, { source: safe.source, seen: [] }, AbortSignal.timeout(60000));
		extraction = { checked: false, latencyMs: Math.round(performance.now() - started), stopReason: response.stopReason,
			tokens: response.usage.totalTokens, inputTokens: response.usage.input, outputTokens: response.usage.output,
			cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite, reportedCost: response.usage.cost.total };
		if (["error", "aborted", "length"].includes(response.stopReason)) throw new Error("incomplete_response");
		const notes = parseNotes(response.content.filter(b => b.type === "text").map(b => b.text).join("\n"), safe.source);
		extraction = { ...extraction, checked: true, notes: notes.length };
	} catch { extraction = { ...extraction, checked: false, latencyMs: Math.round(performance.now() - started) }; }
	const shadow = await shadowPromise;
	const row = { id: fixture.id, category: fixture.category, important: fixture.important, shadow, extraction };
	rows.push(row); console.log(JSON.stringify(row));
}
const important = rows.filter(r => r.important);
const skips = rows.filter(r => r.shadow.wouldSkip);
const falseNegatives = important.filter(r => r.shadow.wouldSkip).map(r => r.id);
const measured = rows.filter(r => r.shadow.inputTokens !== undefined);
const latency = measured.map(r => r.shadow.latencyMs).sort((a, b) => a - b);
const countReasons = {};
for (const row of rows) countReasons[row.shadow.reason] = (countReasons[row.shadow.reason] ?? 0) + 1;
const summary = {
	corpus: "24 frozen synthetic author-labelled cases; not production prevalence or a holdout", fixtures: rows.length,
	important: important.length, importantFalseNegatives: falseNegatives, importantRecall: (important.length - falseNegatives.length) / important.length,
	jevClassifiedImportant: important.filter(r => r.shadow.reason === "classified").length,
	wouldAvoidCalls: skips.length, actualAvoidedCalls: 0,
	potentialCompletedExtractionTokensAvoided: skips.some(r => !r.extraction.checked) ? null : skips.reduce((sum, r) => sum + r.extraction.tokens, 0),
	wouldSkipUnknownBaseline: skips.filter(r => !r.extraction.checked).map(r => r.id),
	wouldSkipWithExtractorNotes: skips.filter(r => r.extraction.checked && r.extraction.notes > 0).map(r => r.id),
	extractionFailures: rows.filter(r => !r.extraction.checked).map(r => r.id),
	abstentions: rows.filter(r => r.shadow.decision === "abstain").length, reasons: countReasons,
	jevCallsWithReportedUsage: measured.length, jevReportedInputTokens: measured.reduce((sum, r) => sum + r.shadow.inputTokens, 0),
	jevReportedOutputTokens: measured.reduce((sum, r) => sum + r.shadow.outputTokens, 0),
	jevLatencyMedianMs: latency.length ? latency[Math.floor(latency.length / 2)] : null,
	jevLatencyP95Ms: latency.length ? latency[Math.min(latency.length - 1, Math.ceil(latency.length * 0.95) - 1)] : null,
	extractionReportedTokens: rows.reduce((sum, r) => sum + (r.extraction.tokens ?? 0), 0),
	monetarySavings: "NOT MEASURED; shadow adds calls and avoids zero actual extraction calls", promotion: "NOT AUTHORIZED",
};
const report = { generatedAt: new Date().toISOString(), extractionModel: process.env.PI_YOU_SHOULD_KNOW_MODEL, config: { model: config.model, timeoutMs: config.timeoutMs }, summary, rows };
console.log(JSON.stringify({ summary }));
if (process.env.YSK_PREFILTER_EVAL_REPORT) writeFileSync(process.env.YSK_PREFILTER_EVAL_REPORT, JSON.stringify(report, null, 2) + "\n");
