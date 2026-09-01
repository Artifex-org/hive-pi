import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import devservicesExtension from "../extensions/devservices/index.ts";
import { pgPaths, runPg } from "../extensions/devservices/pg.ts";

// Real initdb + server + query round trip through the extension's own tool
// surface (HIV-1636). Gated: CI containers have no ~/.hive/tools/postgres,
// and a sandboxed run additionally proves the TCP-only claim in pg.ts:
//
//   PI_DEVSERVICES_IT=1 npx vitest run test/devservices-integration.test.ts

const enabled = process.env.PI_DEVSERVICES_IT === "1" && fs.existsSync(pgPaths().bin);

interface RegisteredTool {
	name: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text?: string }>;
		details: unknown;
	}>;
}

function loadTools(): { tools: Map<string, RegisteredTool>; shutdown: () => void } {
	const tools = new Map<string, RegisteredTool>();
	let onShutdown: (() => void) | undefined;
	const fakePi = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: () => void) {
			if (event === "session_shutdown") onShutdown = handler;
		},
	};
	// This suite exercises the standalone/local tool surface even when the test
	// runner itself is a Hive-launched session. Managed mode has its own real-PG
	// integration suite and intentionally registers no dev_db_* bypass tools.
	const launchID = process.env.HIVE_LAUNCH_ID;
	delete process.env.HIVE_LAUNCH_ID;
	try {
		(devservicesExtension as unknown as (pi: typeof fakePi) => void)(fakePi);
	} finally {
		if (launchID === undefined) delete process.env.HIVE_LAUNCH_ID;
		else process.env.HIVE_LAUNCH_ID = launchID;
	}
	return { tools, shutdown: () => onShutdown?.() };
}

describe.skipIf(!enabled)("extensions/devservices integration", () => {
	const harness = enabled ? loadTools() : null;

	afterAll(async () => {
		await harness?.tools.get("dev_db_stop")?.execute("t-stop", {});
	});

	it("starts, creates a database, answers a query, stops", async () => {
		const out = await harness!.tools.get("dev_db_start")!.execute("t1", { database: "it_db" });
		const details = out.details as { port: number; url: string; data_dir: string };
		expect(details.url).toContain("/it_db");

		// HIV-1966: the directory must carry a per-INSTANCE token, not just the
		// pid — a sandboxed session has its own PID namespace, so pid-only names
		// collided between live sessions sharing /tmp and the second one died on
		// `pre-existing shared memory block`.
		expect(details.data_dir).toMatch(/pi-devservices-\d+-[0-9a-f]{8}\/pg$/);
		expect(fs.existsSync(details.data_dir)).toBe(true);

		const paths = pgPaths();
		const psql = await runPg(paths, "psql", [
			"-h", "127.0.0.1",
			"-p", String(details.port),
			"-U", "dev",
			"-d", "it_db",
			"-tAc", "create table t(x int); insert into t values (7); select x from t;",
		]);
		expect(psql.code).toBe(0);
		expect(psql.stdout.trim()).toContain("7");

		const stop = await harness!.tools.get("dev_db_stop")!.execute("t2", {});
		expect((stop.details as { stopped: boolean }).stopped).toBe(true);
		// Stopping removes the directory too: under the old pid-keyed scheme a
		// leftover cluster was accidentally reused, under this one it is litter,
		// and /tmp filling up is a documented failure mode on this workstation.
		expect(fs.existsSync(details.data_dir)).toBe(false);
	}, 60_000);
});
