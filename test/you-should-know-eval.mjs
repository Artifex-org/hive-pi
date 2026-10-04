// Opt-in relevance sanity check. Synthetic prose only, but REAL provider calls.
// Run: PI_YOU_SHOULD_KNOW_EVAL=1 node --experimental-strip-types test/you-should-know-eval.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { scanOutput } from "../extensions/you-should-know/index.ts";
import { parseNotes } from "../extensions/you-should-know/scan.ts";

if (process.env.PI_YOU_SHOULD_KNOW_EVAL !== "1") {
	throw new Error("Explicitly set PI_YOU_SHOULD_KNOW_EVAL=1: this makes four billable model calls.");
}
const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
const provider = process.env.YSK_EVAL_PROVIDER ?? settings.defaultProvider;
const modelId = process.env.YSK_EVAL_MODEL ?? settings.defaultModel;
const model = runtime.getModel(provider, modelId);
if (!model) throw new Error("Select a configured model with YSK_EVAL_PROVIDER and YSK_EVAL_MODEL.");
const fixtures = [
	{ name: "routine", source: "I am reading the files and checking the test names. Next I will inspect the helpers.", important: false },
	{ name: "buried caveat", source: "Updated all files and the unit suite passes. The migration was not tested against production data. The implementation is ready for review.", important: true },
	{ name: "resolved caveat", source: "Earlier I reported that the migration was not tested against production data. Since then I tested it on a sanitized production snapshot and it passed. That verification gap is resolved; all required checks are green.", important: false },
	{ name: "quoted example", source: 'Documentation example (not a finding): "The migration was not tested against production data." I am only explaining the phrase; this task has no migration or unverified action.', important: false },
];
let tokens = 0;
let cost = 0;
for (const f of fixtures) {
	const response = await scanOutput({ model, modelRegistry: new ModelRegistry(runtime) }, { source: f.source, seen: [] }, AbortSignal.timeout(60_000));
	assert.equal(response.stopReason, "stop");
	const notes = parseNotes(response.content.filter(b => b.type === "text").map(b => b.text).join("\n"), f.source);
	tokens += response.usage.totalTokens;
	cost += response.usage.cost.total;
	console.log(JSON.stringify({ fixture: f.name, notes }));
	assert.equal(notes.length > 0, f.important, `${f.name}: unexpected relevance verdict`);
}
console.log(JSON.stringify({ provider, model: model.id, fixturesPassed: fixtures.length, tokens, reportedCost: cost }));
