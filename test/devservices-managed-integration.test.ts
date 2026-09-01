import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import devservicesExtension from "../extensions/devservices/index.ts";
import type { ResourceReport } from "../extensions/devservices/resource.ts";
import { pgPaths } from "../extensions/devservices/pg.ts";
import { HIVE_SESSION_CHANNEL } from "../extensions/hive-common/channels.ts";
import { createFakePi } from "./fake-pi.ts";

const enabled = process.env.PI_DEVSERVICES_IT === "1" && fs.existsSync(pgPaths().bin);
const savedEnv = { ...process.env };

function response(body: unknown = {}, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function waitUntil(predicate: () => boolean, timeoutMS = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMS;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for managed devservice");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

afterEach(() => {
	process.env = { ...savedEnv };
	vi.unstubAllGlobals();
});

describe.skipIf(!enabled)("managed devservices integration", () => {
	it("claims start, reports healthy, and removes the real PID and data dir on shutdown", async () => {
		process.env.HIVE_LAUNCH_ID = "launch-managed-it";
		process.env.HIVE_TOKEN = "token";
		process.env.HIVE_TELEMETRY_URL = "https://hive.test";
		delete process.env.PI_HIVE_RUN_ID;
		const reports: ResourceReport[] = [];
		let claimed = false;
		let completed = false;
		let refusedReadyOnce = false;
		let rejectShutdownReports = false;
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/agent-sessions/by-run/run-managed-it")) return response({ id: "session-managed-it" });
			if (url.endsWith("/resource-requests/claim")) {
				if (claimed) return response({ items: [] });
				claimed = true;
				return response({
					items: [{
						id: "request-1",
						session_id: "session-managed-it",
						client_call_id: "managed-it",
						resource: "postgres",
						action: "start",
						database_name: "managed_it",
						requested_at: new Date().toISOString(),
						expires_at: new Date(Date.now() + 60_000).toISOString(),
						state: "running",
						claimed_at: new Date().toISOString(),
					}],
				});
			}
			if (url.endsWith("/resources/postgres") && init?.method === "PUT") {
				const report = JSON.parse(String(init.body)) as ResourceReport;
				reports.push(report);
				if (rejectShutdownReports && (report.state === "stopping" || report.state === "ended")) {
					return response({ detail: "Hive unavailable during shutdown" }, 503);
				}
				if (report.state === "ready" && !refusedReadyOnce) {
					refusedReadyOnce = true;
					return response({ detail: "temporary outage" }, 503);
				}
				return response({ resource: {} });
			}
			if (url.endsWith("/resource-requests/request-1/complete")) {
				completed = true;
				return response({ ok: true });
			}
			return response({ detail: `unexpected request: ${url}` }, 404);
		});
		vi.stubGlobal("fetch", fetch);
		const fake = createFakePi();
		devservicesExtension(fake.api);
		fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "run-managed-it" });
		await fake.emit({ type: "session_start", reason: "new" });

		try {
			await waitUntil(() => completed && reports.some((report) => report.state === "ready"));
			const readyReports = reports.filter((report) => report.state === "ready");
			expect(readyReports).toHaveLength(2);
			expect(new Set(readyReports.map((report) => report.generation)).size).toBe(1);
			const ready = readyReports.at(-1);
			expect(ready?.health).toBe("healthy");
			expect(ready?.connection_url).toContain("/managed_it");
			const pid = ready?.process_id;
			expect(pid).toBeTypeOf("number");
			expect(processExists(pid as number)).toBe(true);
			const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
			const dataDir = args[args.indexOf("-D") + 1];
			expect(fs.existsSync(dataDir)).toBe(true);

			rejectShutdownReports = true;
			await fake.emit({ type: "session_shutdown", reason: "quit" });
			expect(reports.at(-1)?.state).toBe("ended");
			expect(processExists(pid as number)).toBe(false);
			expect(fs.existsSync(dataDir)).toBe(false);
		} finally {
			await fake.emit({ type: "session_shutdown", reason: "quit" });
		}
	}, 60_000);
});
