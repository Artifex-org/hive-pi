/**
 * whoami.sh has four answers and they mean different things. Collapsing them
 * is what makes an extension either receive as the wrong role or nag in every
 * project on the machine, so each shape is pinned here — including the one that
 * is easy to get wrong by parsing with `split(" ")`: a project path with a
 * space in it.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeIdentity, parseKeyValues, parseWhoami } from "../extensions/agmsg/identity.ts";
import { parseMode, readDeliveryMode } from "../extensions/agmsg/mode.ts";

describe("parseWhoami", () => {
	it("reads a single registration", () => {
		expect(parseWhoami("agent=alice teams=testteam type=pi project=/home/dev/x\n")).toEqual({
			state: "joined",
			agent: "alice",
			teams: ["testteam"],
			type: "pi",
			project: "/home/dev/x",
		});
	});

	it("keeps a project path that contains spaces intact", () => {
		const identity = parseWhoami("agent=alice teams=a,b type=pi project=/Users/me/My Repos/thing");
		expect(identity).toMatchObject({ state: "joined", project: "/Users/me/My Repos/thing" });
		expect(identity.state === "joined" && identity.teams).toEqual(["a", "b"]);
	});

	it("reports ambiguity instead of picking a name", () => {
		expect(parseWhoami("multiple=true agents=a,b teams=t type=pi project=/x")).toMatchObject({
			state: "multiple",
			agents: ["a", "b"],
		});
	});

	it("distinguishes a suggestion from a registration", () => {
		expect(parseWhoami("suggest=true agents=alice teams=t type=pi project=/x available_teams=t,u")).toMatchObject({
			state: "suggest",
			agents: ["alice"],
			availableTeams: ["t", "u"],
		});
	});

	it("reads not-joined, and treats the literal 'none' as an empty list", () => {
		expect(parseWhoami("not_joined=true available_teams=none")).toEqual({ state: "not-joined", availableTeams: [] });
		expect(parseWhoami("not_joined=true available_teams=a,b")).toEqual({
			state: "not-joined",
			availableTeams: ["a", "b"],
		});
	});

	it("falls back to not-joined on output it cannot read, rather than a half-identity", () => {
		expect(parseWhoami("")).toEqual({ state: "not-joined", availableTeams: [] });
		expect(parseWhoami("something unexpected")).toEqual({ state: "not-joined", availableTeams: [] });
	});

	it("reads the LAST line, so a stray notice above the answer cannot shift the parse", () => {
		const out = "agmsg: external plugin 'types/pi' found\nagent=alice teams=t type=pi project=/x";
		expect(parseWhoami(out)).toMatchObject({ state: "joined", agent: "alice" });
	});
});

describe("parseKeyValues", () => {
	it("gives each value everything up to the next key", () => {
		expect(parseKeyValues("a=1 b=two words c=3")).toEqual({ a: "1", b: "two words", c: "3" });
	});
});

describe("describeIdentity", () => {
	it("says what is wrong, in the words the status line shows", () => {
		expect(describeIdentity({ state: "joined", agent: "alice", teams: ["t"], type: "pi", project: "/x" })).toBe(
			"alice @ t",
		);
		expect(describeIdentity({ state: "not-joined", availableTeams: ["t"] })).toBe("not joined (teams: t)");
	});
});

describe("delivery mode", () => {
	it("reads the file agmsg's driver writes", () => {
		expect(parseMode('{"mode": "monitor"}')).toBe("monitor");
		expect(parseMode('{"mode": "turn"}')).toBe("turn");
	});

	it("reads anything it cannot understand as off — an unreadable mode must start nothing", () => {
		expect(parseMode("{ not json")).toBe("off");
		expect(parseMode('{"mode": "both"}')).toBe("off");
		expect(parseMode("{}")).toBe("off");
	});

	it("treats an absent file as off", () => {
		const dir = mkdtempSync(join(tmpdir(), "agmsg-mode-"));
		try {
			expect(readDeliveryMode(dir)).toBe("off");
			mkdirSync(join(dir, ".pi"));
			writeFileSync(join(dir, ".pi", "agmsg.json"), '{"mode":"monitor"}');
			expect(readDeliveryMode(dir)).toBe("monitor");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
