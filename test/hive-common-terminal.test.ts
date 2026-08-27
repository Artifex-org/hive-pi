import { afterEach, describe, expect, it } from "vitest";
import { resolveTerminal } from "../extensions/hive-common/identity.ts";

// A session's tmux location is what lets an operator JOIN it at the machine.
// The launched case is told; the hand-started case has to ask tmux — and the
// hand-started case is the one that earns this, because tmux names those
// sessions "0", "4", "7", which is exactly what a sidebar cannot disambiguate.

const saved = { HIVE_TMUX_SESSION: process.env.HIVE_TMUX_SESSION, TMUX: process.env.TMUX };

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("resolveTerminal", () => {
	it("prefers what the launcher told it, without spawning anything", () => {
		process.env.HIVE_TMUX_SESSION = "hive-agents-hive";
		// Deliberately NOT inside tmux: the told answer must not depend on it.
		delete process.env.TMUX;
		expect(resolveTerminal()).toEqual({ name: "hive-agents-hive", kind: "tmux" });
	});

	// $TMUX is set by the server on every pane, so its absence is proof we are
	// not in tmux — and answering that without a subprocess is the common case.
	it("reports nothing outside tmux", () => {
		delete process.env.HIVE_TMUX_SESSION;
		delete process.env.TMUX;
		expect(resolveTerminal()).toBeNull();
	});

	// A dead socket, a server that went away, no tmux binary at all. A session
	// whose location cannot be named is still a session.
	it("degrades to nothing when tmux cannot answer", () => {
		delete process.env.HIVE_TMUX_SESSION;
		process.env.TMUX = "/nonexistent/socket,0,0";
		expect(resolveTerminal()).toBeNull();
	});

	it("bounds a name the server cannot store", () => {
		process.env.HIVE_TMUX_SESSION = "x".repeat(500);
		expect(resolveTerminal()!.name.length).toBeLessThanOrEqual(200);
	});

	it("ignores an empty announcement rather than reporting a blank location", () => {
		process.env.HIVE_TMUX_SESSION = "   ";
		delete process.env.TMUX;
		expect(resolveTerminal()).toBeNull();
	});
});
