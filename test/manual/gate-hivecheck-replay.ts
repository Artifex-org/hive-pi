// Manual driver (see README): exercise the FOLLOW half against a run that already finished, so
// the terminal transition, the fold over real server JSON and the final report
// are observed on real data rather than on fixtures.
import { failedTaskLogs, follow, resolveCheckAuth } from "../../extensions/gate/hiverun.ts";
import { deckSummary, renderReport } from "../../extensions/gate/hivecheck.ts";

const id = process.argv[2];
const auth = resolveCheckAuth()!;
const ref = { id, url: `${auth.url}/runs/${id}` };

const { progress, tasks, timedOut } = await follow(auth, ref, ["(replay)"], undefined, (p) =>
	console.log("tick:", deckSummary(p)),
);
console.log("timedOut:", timedOut);
console.log("--- spec ---");
console.log(JSON.stringify(progress, null, 2));
console.log("--- report ---");
console.log(renderReport(progress, { logs: progress.status === "fail" ? await failedTaskLogs(auth, tasks) : [] }));
