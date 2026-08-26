import { describe, expect, it } from "vitest";
import {
	parseTeamMessage,
	renderTeamMessage,
	triggersTurn,
	type TeamDigest,
	type TeamMessage,
} from "../extensions/hive-remote/team.ts";

// team.ts is the wire contract for Hive's team_message command (HIV-1195). It
// is pure precisely so the parse/render behavior — including how a newer
// server's payload degrades on an older client — can be pinned down without a
// running agent.

describe("parseTeamMessage", () => {
	it("parses a full direct message", () => {
		const msg = parseTeamMessage(
			JSON.stringify({
				category: "message",
				text: "please review the PR",
				from_session_id: "sess-orch",
				from_title: "Orchestrator",
				self_session_id: "sess-self",
				team_id: "team-1",
				teammates: [{ id: "sess-w2", title: "Worker 2" }],
			}),
		);

		expect(msg).toEqual({
			category: "message",
			text: "please review the PR",
			fromSessionID: "sess-orch",
			fromTitle: "Orchestrator",
			selfSessionID: "sess-self",
			teammates: [{ id: "sess-w2", title: "Worker 2" }],
		});
	});

	it("parses relationship and lifecycle categories", () => {
		expect(parseTeamMessage(JSON.stringify({ category: "relationship", text: "joined team" }))?.category).toBe("relationship");
		expect(parseTeamMessage(JSON.stringify({ category: "lifecycle", text: "worker finished" }))?.category).toBe("lifecycle");
	});

	it("parses the digest and note categories (HIV-1488)", () => {
		expect(parseTeamMessage(JSON.stringify({ category: "digest", text: "3 members" }))?.category).toBe("digest");
		expect(parseTeamMessage(JSON.stringify({ category: "note", text: "taking the store layer" }))?.category).toBe("note");
	});

	// Forward compatibility: an unknown category is informational until proven
	// otherwise, so a newer server does not break an older client.
	it("treats an unknown or missing category as lifecycle", () => {
		expect(parseTeamMessage(JSON.stringify({ category: "celebration", text: "shipped" }))?.category).toBe("lifecycle");
		expect(parseTeamMessage(JSON.stringify({ text: "no category at all" }))?.category).toBe("lifecycle");
	});

	it("returns null on garbage", () => {
		expect(parseTeamMessage("not json {")).toBeNull();
		expect(parseTeamMessage("")).toBeNull();
		expect(parseTeamMessage('"just a string"')).toBeNull();
		expect(parseTeamMessage("[1,2,3]")).toBeNull();
		expect(parseTeamMessage("null")).toBeNull();
	});

	it("returns null when text is missing, empty or not a string", () => {
		expect(parseTeamMessage(JSON.stringify({ category: "message" }))).toBeNull();
		expect(parseTeamMessage(JSON.stringify({ category: "message", text: "" }))).toBeNull();
		expect(parseTeamMessage(JSON.stringify({ category: "message", text: 42 }))).toBeNull();
	});

	it("drops malformed optional fields instead of copying them", () => {
		const msg = parseTeamMessage(
			JSON.stringify({
				category: "message",
				text: "hi",
				from_session_id: 7,
				from_title: null,
				self_session_id: ["nope"],
				teammates: [{ id: "ok-1", title: "Ok" }, { id: 5, title: "bad id" }, "garbage", { title: "no id" }],
			}),
		);

		expect(msg).toEqual({
			category: "message",
			text: "hi",
			teammates: [{ id: "ok-1", title: "Ok" }],
		});
	});
});

describe("renderTeamMessage", () => {
	it("renders a direct message with title and sender id", () => {
		const msg: TeamMessage = { category: "message", text: "on it", fromTitle: "Orchestrator", fromSessionID: "sess-1" };
		expect(renderTeamMessage(msg)).toBe('Team message from "Orchestrator" (sess-1): on it');
	});

	it("degrades gracefully as sender fields go missing", () => {
		expect(renderTeamMessage({ category: "message", text: "hi", fromTitle: "Orchestrator" })).toBe('Team message from "Orchestrator": hi');
		expect(renderTeamMessage({ category: "message", text: "hi", fromSessionID: "sess-1" })).toBe("Team message from sess-1: hi");
		expect(renderTeamMessage({ category: "message", text: "hi" })).toBe("Team message: hi");
	});

	it("renders relationship and lifecycle as team updates", () => {
		expect(renderTeamMessage({ category: "relationship", text: "you now report to sess-1" })).toBe("Team update: you now report to sess-1");
		expect(renderTeamMessage({ category: "lifecycle", text: "worker sess-2 finished" })).toBe("Team update: worker sess-2 finished");
	});

	// The self id line is what lets the agent name itself to the hive MCP tools.
	it("appends the self session id line when present", () => {
		expect(renderTeamMessage({ category: "message", text: "hi", selfSessionID: "sess-self" })).toBe(
			"Team message: hi\n(Your Hive session id: sess-self)",
		);
	});

	it("appends the teammates line when present and non-empty", () => {
		const msg: TeamMessage = {
			category: "lifecycle",
			text: "team formed",
			selfSessionID: "sess-self",
			teammates: [
				{ id: "sess-1", title: "Orchestrator" },
				{ id: "sess-2", title: "Worker 2" },
			],
		};
		expect(renderTeamMessage(msg)).toBe(
			"Team update: team formed\n(Your Hive session id: sess-self)\nTeammates: Orchestrator (sess-1), Worker 2 (sess-2)",
		);
	});

	it("omits the teammates line for an empty list", () => {
		expect(renderTeamMessage({ category: "lifecycle", text: "alone", teammates: [] })).toBe("Team update: alone");
	});

	it("renders a pushed note with its author", () => {
		expect(renderTeamMessage({ category: "note", text: "[claim] taking the store layer", fromTitle: "Worker 2" })).toBe(
			'Team note from "Worker 2": [claim] taking the store layer',
		);
		expect(renderTeamMessage({ category: "note", text: "[claim] taking the store layer" })).toBe(
			"Team note: [claim] taking the store layer",
		);
	});
});

describe("renderTeamMessage — digest (HIV-1488)", () => {
	const digest: TeamDigest = {
		teamName: "hive-dogfood",
		members: [
			{ id: "s1", title: "Orchestrator", liveState: "active", branch: "feat/a", plan: "execute 3/7", self: true },
			{ id: "s2", title: "Worker 2", liveState: "active", branch: "feat/b", pr: "#12 open, ci ✓" },
			{ id: "s3", title: "Worker 3", liveState: "done" },
		],
		notes: [
			{ kind: "claim", subject: "taking the store layer", author: "Worker 2" },
			{ kind: "decision", subject: "DB table, not git" },
		],
		conflicts: ["Worker 2 and Worker 3 are both on feat/b"],
	};

	// Conflicts before the roster, on purpose: the one line in a digest that
	// should change what the agent does next must not be buried under members.
	it("puts conflicts first, then members, then notes", () => {
		expect(renderTeamMessage({ category: "digest", text: "3 members, 2 new notes", digest })).toBe(
			[
				"Team digest — hive-dogfood",
				"3 members, 2 new notes",
				"Conflicts:",
				"  ! Worker 2 and Worker 3 are both on feat/b",
				"Members (3):",
				"  • Orchestrator (you) — active · branch feat/a · plan execute 3/7",
				"  • Worker 2 — active · branch feat/b · #12 open, ci ✓",
				"  • Worker 3 — done",
				"New shared notes (read_team_notes for the bodies):",
				"  - [claim] Worker 2: taking the store layer",
				"  - [decision] DB table, not git",
			].join("\n"),
		);
	});

	// The compatibility contract in both directions: the server always sends
	// prose, so a digest whose structured half is missing or unreadable still
	// reads as an update rather than vanishing.
	it("falls back to the server's prose when the structured half is absent", () => {
		expect(renderTeamMessage({ category: "digest", text: "3 members, 2 new notes" })).toBe(
			"Team update: 3 members, 2 new notes",
		);
	});

	it("parses a digest payload and drops malformed entries", () => {
		const msg = parseTeamMessage(
			JSON.stringify({
				category: "digest",
				text: "2 members",
				self_session_id: "s1",
				digest: {
					team_name: "hive-dogfood",
					members: [
						{ id: "s1", title: "Orchestrator", live_state: "active", self: true },
						{ title: "no id at all" },
						"garbage",
						{ id: "s2", title: "Worker 2", branch: 7 },
					],
					notes: [{ kind: "claim", subject: "took it", author: "Worker 2" }, { kind: "note" }],
					conflicts: ["both on feat/b", 42],
				},
			}),
		);

		expect(msg?.digest).toEqual({
			teamName: "hive-dogfood",
			members: [
				{ id: "s1", title: "Orchestrator", liveState: "active", self: true },
				{ id: "s2", title: "Worker 2" },
			],
			notes: [{ kind: "claim", subject: "took it", author: "Worker 2" }],
			conflicts: ["both on feat/b"],
		});
	});

	it("leaves digest undefined when the payload carries nothing usable", () => {
		expect(parseTeamMessage(JSON.stringify({ category: "digest", text: "hi", digest: {} }))?.digest).toBeUndefined();
		expect(parseTeamMessage(JSON.stringify({ category: "digest", text: "hi", digest: "nope" }))?.digest).toBeUndefined();
		expect(parseTeamMessage(JSON.stringify({ category: "digest", text: "hi", digest: [] }))?.digest).toBeUndefined();
	});
});

describe("triggersTurn", () => {
	// Only a direct teammate message wakes an idle agent; relationship and
	// lifecycle notices are context, delivered as followUp for the next turn.
	it("is true only for direct messages", () => {
		expect(triggersTurn("message")).toBe(true);
		expect(triggersTurn("relationship")).toBe(false);
		expect(triggersTurn("lifecycle")).toBe(false);
	});

	// The load-bearing one (HIV-1488): a digest goes to EVERY member on a timer.
	// If it woke them, an idle team would bill a full turn per member per sweep
	// forever. This assertion is the whole reason the push is affordable.
	it("does not wake an idle agent for a digest or a pushed note", () => {
		expect(triggersTurn("digest")).toBe(false);
		expect(triggersTurn("note")).toBe(false);
	});
});
