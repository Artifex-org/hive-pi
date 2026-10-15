import { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ reads: [] as string[], root: 990000001, old: 990000002, member: 990000003, equal: 990000004, missingRoot: false }));
vi.mock("node:fs", async original => {
	const fs = await original<typeof import("node:fs")>();
	return { ...fs,
		readdirSync: vi.fn((path, ...args) => String(path) === "/proc" ? [state.root, state.old, state.member, state.equal].map(String) : (fs.readdirSync as (...args: unknown[]) => unknown)(path, ...args)),
		readFileSync: vi.fn((path, ...args) => {
			const name = String(path), match = /^\/proc\/(\d+)\/(stat|environ)$/.exec(name);
			if (match && [state.root, state.old, state.member, state.equal].includes(Number(match[1]))) {
				if (match[2] === "environ") { state.reads.push(name); return `HIVE_PI_TREE_TOKENS=${Number(match[1]) === state.old ? "unrelated" : "this-job"}\0`; }
				if (state.missingRoot && Number(match[1]) === state.root) throw new Error("root already exited");
				const fields = Array<string>(20).fill("0"); fields[0] = "S"; fields[1] = "1";
				fields[19] = Number(match[1]) === state.old ? "50" : Number(match[1]) === state.member ? "101" : "100";
				return `${match[1]} (fixture) ${fields.join(" ")}`;
			}
			return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...args);
		}),
	};
});
import { killTree, trackTree } from "../extensions/hive-common/child-tree.ts";

function discover(missingRoot: boolean) {
	state.reads.length = 0; state.missingRoot = missingRoot;
	// Unspawned runtime handle for synthetic /proc rows; never a real PID.
	const child = new ChildProcess(); Object.defineProperty(child, "pid", { value: state.root }); child.kill = vi.fn(() => true);
	const send = vi.spyOn(process, "kill").mockReturnValue(true);
	try {
		trackTree(child, false, "this-job"); killTree(child, "SIGKILL", false);
		if (!missingRoot) expect(state.reads).not.toContain(`/proc/${state.old}/environ`);
		else expect(state.reads).toContain(`/proc/${state.old}/environ`); // no safe age bound
		for (const pid of [state.member, state.equal]) {
			expect(state.reads).toContain(`/proc/${pid}/environ`);
			expect(send).toHaveBeenCalledWith(pid, "SIGKILL");
		}
		expect(send).not.toHaveBeenCalledWith(state.old, expect.anything());
	} finally { child.emit("close", 0); state.missingRoot = false; send.mockRestore(); }
}

describe.runIf(process.platform === "linux")("inherited token birth bound", () => {
	it("excludes older environment pages but retains newer and equal-start-tick descendants", () => discover(false));
	it("conservatively scans tokens when the root vanished before identity capture", () => discover(true));
});
