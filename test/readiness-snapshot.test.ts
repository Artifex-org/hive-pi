import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePi } from "./fake-pi.ts";
const probes = vi.hoisted(() => ({ socket: vi.fn(), all: vi.fn() }));
vi.mock("../extensions/readiness/probes.ts", () => ({
	realDeps: () => ({}), unixSocketProbe: () => {},
	runProbe: probes.socket, runAll: probes.all,
}));
import readiness, { snapshotEnabled } from "../extensions/readiness/index.ts";
beforeEach(() => {
	vi.useFakeTimers(); vi.stubEnv("PI_READINESS", "1"); vi.stubEnv("PI_READINESS_SNAPSHOT", "");
	vi.stubEnv("HIVE_LAUNCH_ID", "launch"); vi.stubEnv("SANDBOX_RUNTIME", "1");
	probes.socket.mockResolvedValue({ id: "unix-sockets", label: "unix sockets", status: "absent", detail: "EPERM", hint: "run tests on CI", at: 1 });
	probes.all.mockResolvedValue([]);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("sandbox readiness snapshot", () => {
	it("defaults on only for sandboxed Hive launches, with an explicit off switch", () => {
		expect(snapshotEnabled({ HIVE_LAUNCH_ID: "x", SANDBOX_RUNTIME: "1" })).toBe(true);
		for (const env of [{}, { HIVE_LAUNCH_ID: "x" }, { HIVE_LAUNCH_ID: "x", SANDBOX_RUNTIME: "0" }, { SANDBOX_RUNTIME: "1" }, { HIVE_LAUNCH_ID: "x", SANDBOX_RUNTIME: "1", PI_READINESS_SNAPSHOT: "0" }]) expect(snapshotEnabled(env)).toBe(false);
		expect(snapshotEnabled({ PI_READINESS_SNAPSHOT: "1" })).toBe(true);
	});
	it("injects socket absence on the FIRST turn even before the detached probe runs, only once", async () => {
		const pi = createFakePi(); readiness(pi.api);
		await pi.emit({ type: "session_start", reason: "new" });
		const [result] = await pi.emit({ type: "before_agent_start" });
		expect(result).toMatchObject({ message: { customType: "readiness-snapshot", content: expect.stringContaining("unix sockets"), display: false } });
		expect(JSON.stringify(result)).toContain("EPERM"); expect(probes.all).not.toHaveBeenCalled();
		expect(await pi.emit({ type: "before_agent_start" })).toEqual([undefined]);
		expect(probes.socket).toHaveBeenCalledTimes(1);
		expect(probes.socket.mock.calls[0][4]).toBe(250);
	});
	it("does not let a late probe from the previous session overwrite the current row", async () => {
		let resolveOld!: (rows: unknown[]) => void;
		probes.all.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
		const pi = createFakePi(); readiness(pi.api);
		await pi.emit({ type: "session_start", reason: "new" }); await vi.advanceTimersByTimeAsync(0);
		await pi.emit({ type: "session_start", reason: "new" });
		const [current] = await pi.emit({ type: "before_agent_start" });
		expect(JSON.stringify(current)).toContain("EPERM");
		resolveOld([{ id: "unix-sockets", label: "unix sockets", status: "ready", detail: "old ready", at: 2 }]);
		await vi.advanceTimersByTimeAsync(0);
		expect(JSON.stringify(pi.entries.at(-1))).not.toContain("old ready");
	});
	it.each(["resume", "fork", "reload"])("does not repeat on %s", async (reason) => {
		const pi = createFakePi(); readiness(pi.api); await pi.emit({ type: "session_start", reason });
		expect(await pi.emit({ type: "before_agent_start" })).toEqual([undefined]); expect(probes.socket).not.toHaveBeenCalled();
	});
	it("opt-out does not probe synchronously or inject", async () => {
		vi.stubEnv("PI_READINESS_SNAPSHOT", "0"); const pi = createFakePi(); readiness(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		expect(await pi.emit({ type: "before_agent_start" })).toEqual([undefined]); expect(probes.socket).not.toHaveBeenCalled();
	});
});
