#!/usr/bin/env node
/**
 * typesafe-route-replay — does a two-stage Jev router beat the lexical ranker?
 *
 *   node scripts/typesafe-route-replay.ts
 *   node scripts/typesafe-route-replay.ts --cache /path/to/mcp-cache.json
 *   node scripts/typesafe-route-replay.ts --live        # needs TYPESAFE_API_KEY
 *
 * PHASE 0. This changes no behaviour: nothing in `extensions/typesafe-common/`
 * is loaded as an extension (no `index.ts`, by the same rule `hive-common` and
 * `mcp-common` follow), nothing registers a handler, and no production code
 * path consults Jev. This script is the whole consumer.
 *
 * ## It runs green with no API key, and that is the point
 *
 * Without `--live` it still does the part that can prove or kill the design:
 * it checks, EXHAUSTIVELY and offline, that for every labelled query and every
 * category stage 1 could possibly pick — including the wrong one, including
 * none at all — the correct tool is on stage 2's ballot. That is the structural
 * floor, and if it ever fails, the router is dead regardless of how well the
 * classifier performs. No key is needed to find that out.
 *
 * ## --live is the consent, not the key
 *
 * `hive-common/identity.ts:100-103` states the rule: a credential in the
 * environment is a SOURCE, never a consent signal. This script ships MCP tool
 * names and descriptions off the machine, so it needs both the flag and the
 * key. With the key alone it prints `skipped` — never `0/5`, which would read
 * as a measured failure of the router rather than a measurement that never ran.
 *
 * Everything foldable lives in `extensions/typesafe-common/replay.ts` and is
 * unit-tested; this file is argv, files and printing, which are not.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadToolCorpus } from "../extensions/mcp-common/search.ts";
import { TypesafeClient, estimateTokens } from "../extensions/typesafe-common/client.ts";
import { configFrom } from "../extensions/typesafe-common/config.ts";
import { readApiKey } from "../extensions/typesafe-common/key.ts";
import {
	DEFAULT_MIN_MEMBERS,
	categorise,
	categoryCriteria,
} from "../extensions/typesafe-common/router.ts";
import {
	floorCoverage,
	formatMisses,
	formatReport,
	parseLabels,
	resolveLabels,
	routeOne,
	runLexical,
	summarise,
	type Trial,
} from "../extensions/typesafe-common/replay.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = join(here, "fixtures", "typesafe-route-labels.json");

function flag(argv: readonly string[], name: string): boolean {
	return argv.includes(`--${name}`);
}

function option(argv: readonly string[], name: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const live = flag(argv, "live");
	const fixturePath = resolve(option(argv, "fixture") ?? DEFAULT_FIXTURE);
	const cachePath = option(argv, "cache");
	const rawMinMembers = option(argv, "min-members");
	const minMembers = rawMinMembers === undefined ? DEFAULT_MIN_MEMBERS : Number(rawMinMembers);
	// NaN (or 0, or 2.5) used to reach categorise() and silently collapse every
	// server into one catch-all category — while the report still printed
	// "floor holds", about a router nobody would ship. Refuse it instead.
	if (!Number.isInteger(minMembers) || minMembers < 1) {
		console.error(`--min-members must be a positive integer, got ${JSON.stringify(rawMinMembers)}`);
		return 2;
	}

	const corpus = loadToolCorpus(cachePath === undefined ? {} : { cachePath });
	console.log(`corpus: ${corpus.tools.length} tools across ${Object.keys(corpus.servers).length} servers`);
	if (corpus.tools.length === 0) {
		// Not a failure: a clean checkout on a machine with no MCP cache is a
		// supported state. Exiting 0 with the reason printed keeps this runnable
		// in CI without pretending it measured anything.
		console.log("no MCP cache on this machine — nothing to replay. (Pass --cache <file> to point at one.)");
		return 0;
	}

	const labels = parseLabels(JSON.parse(readFileSync(fixturePath, "utf8")));
	const { resolved, unresolved } = resolveLabels(corpus, labels);
	console.log(`labels: ${resolved.length} resolved, ${unresolved.length} not present in this corpus`);
	for (const row of unresolved) console.log(`  unresolved: "${row.query}" -> ${row.expect.server}/${row.expect.name}`);
	if (resolved.length === 0) {
		console.log("no labelled query resolves against this corpus — nothing to replay.");
		return 0;
	}

	const categorisation = categorise(corpus.tools, { minMembers });
	const stage1Tokens = estimateTokens(categoryCriteria(categorisation.categories));
	console.log(
		`categories: ${categorisation.categories.length} (min-members ${minMembers}), ` +
			`stage-1 criteria ~${stage1Tokens} tokens`,
	);

	// ---- the offline proof -------------------------------------------------
	console.log("\nstructural floor — is the right answer on stage 2's ballot for EVERY category?");
	let floorHolds = true;
	for (const label of resolved) {
		const coverage = floorCoverage(corpus, categorisation, label);
		const verdict = coverage.categoriesMissingExpected.length === 0 ? "HOLDS" : "BROKEN";
		if (coverage.categoriesMissingExpected.length > 0) floorHolds = false;
		console.log(
			`  ${verdict}  "${label.query}"\n` +
				`         lexical rank ${coverage.lexicalRank ?? "unranked"} · ` +
				`${coverage.categoriesChecked} ballots checked · ` +
				`${coverage.categoriesMissingExpected.length} missing · ` +
				`max ${coverage.maxOptions} options${coverage.anyTruncated ? " (budget truncated a category)" : ""}`,
		);
		for (const key of coverage.categoriesMissingExpected.slice(0, 5)) console.log(`         missing in: ${key}`);
	}

	// ---- strategies --------------------------------------------------------
	const now = () => performance.now();
	console.log("\nstrategies");
	const lexical = summarise("lexical rankByAnyToken (baseline)", runLexical(corpus, resolved, now));
	console.log(formatReport(lexical));
	for (const line of formatMisses(lexical, resolved)) console.log(line);

	const apiKey = readApiKey();
	if (!live || apiKey === null) {
		const reason = !live ? "no --live flag" : "no TYPESAFE_API_KEY / stored credential";
		console.log(`  two-stage jev router\n    skipped (${reason})`);
	} else {
		// `--live` IS the enable. The stored config is not consulted, because a
		// deliberate one-shot operator run is a different decision from "this
		// machine has the feature on" — and because a replay that silently
		// obeyed a config file would report "skipped" for a reason not on screen.
		const client = new TypesafeClient({ config: configFrom({ enabled: true, timeoutMs: 10_000 }), apiKey });
		const trials: Trial[] = [];
		for (const label of resolved) {
			trials.push(await routeOne(client, corpus, categorisation, label, now));
		}
		const jev = summarise("two-stage jev router", trials);
		console.log(formatReport(jev));
		for (const line of formatMisses(jev, resolved)) console.log(line);
		// Cold vs warm, separated. The measured gap is ~1.4-2.1s cold including
		// TLS against a 299ms warm median, so a first call that is not visibly
		// slower than the rest means keep-alive is NOT in effect and the rest of
		// the latency column is measuring something other than what it claims.
		const [first, ...rest] = trials.map((t) => Math.round(t.latencyMs));
		console.log(`    first call ${first ?? "n/a"}ms · subsequent ${rest.length === 0 ? "n/a" : rest.join(", ") + "ms"}`);
		console.log(`    floor-only routes (stage 1 gave nothing): ${trials.filter((t) => t.floorOnly).length}/${trials.length}`);
	}

	// A broken floor is the "kills" half and must be loud, but this is a
	// measurement tool and not a gate: `npm run check` does not run it.
	console.log(`\nverdict: structural floor ${floorHolds ? "holds" : "IS BROKEN — do not ship this router"}`);
	return 0;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	},
);
