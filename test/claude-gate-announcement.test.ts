import { describe, expect, it, vi } from "vitest";
import { BackgroundJobs } from "../claude/mcp/subagent-tool.ts";
import { startWatchRun, type WatchHost } from "../claude/mcp/watch-run-tool.ts";

const uuid = "1d363f69-ed6d-40c3-80b1-55bf40cc8640";
function fixture(): WatchHost {
	return { cwd: "/tmp", jobs: new BackgroundJobs(() => {}), canWake: true, auth: { url: "https://hive.example", token: "test" },
		spool: { usage: vi.fn(), gate: vi.fn(), wake: vi.fn() } };
}
describe("gate watcher announcement cancellation", () => {
	it("does not register a watch when cancellation lands during resolution", async () => {
		const host = fixture();
		const controller = new AbortController();
		let resolve!: (value: { ok: boolean; status: number; body: unknown }) => void;
		host.getJSON = () => new Promise((done) => { resolve = done; });
		const start = vi.spyOn(host.jobs, "start");
		const result = startWatchRun({ run: "1", project: "hive", what: "gate verdict" }, host, controller.signal);
		controller.abort(); resolve({ ok: true, status: 200, body: { runs: [{ id: uuid, number: 1 }] } });
		expect((await result).isError).toBe(true);
		expect(start).not.toHaveBeenCalled(); expect(host.jobs.size).toBe(0);
	});
	it("releases a watcher if cancellation lands during registration before the response", async () => {
		const host = fixture();
		const controller = new AbortController();
		const cancel = vi.spyOn(host.jobs, "cancel").mockReturnValue(true);
		vi.spyOn(host.jobs, "start").mockImplementation(() => { controller.abort(); return "watch-1-test"; });
		await startWatchRun({ run: uuid, what: "gate verdict" }, host, controller.signal);
		expect(cancel).toHaveBeenCalledExactlyOnceWith("watch-1-test");
		expect(host.spool.wake).not.toHaveBeenCalled();
	});
});
