// Manual driver (see README): the extension's hive-check path, live.
// A typecheck is not a smoke test (KB harness-engineering) — this dispatches a
// real run and prints every snapshot the widget would have shipped.
import { dispatch, failedTaskLogs, follow, hivePipelineDir, resolveCheckAuth } from "../../extensions/gate/hiverun.ts";
import { deckLines, deckSummary, renderReport, stepsFrom } from "../../extensions/gate/hivecheck.ts";

const cwd = process.argv[2];
const steps = stepsFrom(process.argv[3]);

console.log("pipeline dir:", await hivePipelineDir(cwd));
const auth = resolveCheckAuth();
console.log("auth:", auth ? `${auth.url} (token ${auth.token.length} chars)` : "NONE");
if (!auth) process.exit(1);

const t0 = Date.now();
const d = await dispatch(steps, cwd, undefined);
console.log("dispatch exit", d.code, "ref", d.ref);
console.log("--- cli said ---\n" + d.out.trim() + "\n----------------");
if (!d.ref) process.exit(1);

let ticks = 0;
const { progress, tasks, timedOut } = await follow(auth, d.ref, steps, undefined, (p) => {
	ticks++;
	console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, deckSummary(p), "|", JSON.stringify(deckLines(p)));
});
console.log("ticks:", ticks, "timedOut:", timedOut);
console.log("--- spec ---");
console.log(JSON.stringify(progress, null, 2));
console.log("--- report ---");
console.log(renderReport(progress, { logs: progress.status === "fail" ? await failedTaskLogs(auth, tasks) : [] }));
