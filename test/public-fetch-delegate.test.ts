/** Actual native delegation spawn, with a fake Pi binary that records environment/argv (not retrieval). */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { discoverAgents } from "../extensions/harness/roles.ts";
import { runSingleDelegation, type DelegationHost } from "../extensions/subagent/delegate.ts";
import { makeLaunch } from "./claude-harness.ts";

afterEach(() => vi.unstubAllEnvs());

it("the native spawn carries the explicit scoped broker credential and grant, not an operator override", async () => {
	const launch = makeLaunch();
	const capture = join(launch.root, "child-env.json");
	try {
		vi.stubEnv("PI_HOUSE_PI_BIN", launch.piBin);
		vi.stubEnv("PI_CODING_AGENT_DIR", launch.agentDir);
		vi.stubEnv("HIVE_URL", "https://hive.example.com");
		vi.stubEnv("HIVE_TOKEN", "scoped-launch-fixture");
		vi.stubEnv("HIVE_TELEMETRY_TOKEN", "operator-fixture-must-not-replace-scoped");
		await writeFile(launch.piBin, `#!${process.execPath}
const fs = require("node:fs");
fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ url: process.env.HIVE_URL, token: process.env.HIVE_TOKEN, worker: process.env.PI_AGENDA_WORKER, argv: process.argv.slice(2) }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Environment capture complete." }] } }));
`);
		const host: DelegationHost = {
			signal: undefined, cwd: launch.root, agents: discoverAgents(launch.root, "user").agents,
			modelEnv: { isConfigured: () => true, catalog: async () => [] },
			makeDetails: mode => results => ({ mode, agentScope: "user", projectAgentsDir: null, results }),
		};
		const outcome = await runSingleDelegation({ agent: "research", task: "Capture native worker environment.", model: "zai/glm-low" }, "off", host);
		expect(outcome.isError).toBeUndefined();
		const child = JSON.parse(await readFile(capture, "utf8"));
		expect(child).toMatchObject({ url: "https://hive.example.com", token: "scoped-launch-fixture", worker: "1" });
		expect(child.argv).toContain("--no-extensions");
		expect(child.argv.some((arg: string, index: number) => arg.endsWith("/public-fetch/index.ts") && child.argv[index - 1] === "-e")).toBe(true);
		expect(child.argv[child.argv.indexOf("--tools") + 1].split(",")).toContain("fetch_public_url");
		expect(child.argv).not.toContain("builtin:mcp");
	} finally { await rm(launch.root, { recursive: true, force: true }); }
}, 15_000);
