/**
 * brief — which model compiles the brief (HIV-1798).
 *
 * The behaviour under test is a cost claim, not a preference: the brief exists
 * to keep a frontier model from searching, so running it on a frontier model is
 * strictly worse than not running it. `pickBriefModel` returning null must mean
 * "stand down", and the last test here is the one that keeps it that way.
 */

import { describe, expect, it } from "vitest";
import { pickBriefModel } from "../extensions/brief/model.ts";
import type { AgentMode } from "../extensions/advisor/modes.ts";

/** The live catalog on 2026-08-13, ordered highest class first. */
const LADDER: AgentMode[] = [
	{ key: "high", label: "High", model: "openai-codex/gpt-5.6-sol", thinking: "high" },
	{ key: "medium", label: "Medium", model: "openai-codex/gpt-5.6-terra", thinking: "high" },
	{ key: "low", label: "Low", model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" },
];

describe("pickBriefModel", () => {
	it("takes the cheap end of the ladder — today's low tier", () => {
		expect(pickBriefModel(LADDER, undefined)).toEqual({ spec: "openai-codex/gpt-5.6-luna", source: "mode:low" });
	});

	it("prefers the server's declared delegation mode over the ladder's tail", () => {
		// The fleet may decide delegations belong somewhere other than the
		// bottom rung. `subagent_key` is Hive's own statement of that, and it wins.
		expect(pickBriefModel(LADDER, "medium")).toEqual({ spec: "openai-codex/gpt-5.6-terra", source: "mode:medium" });
	});

	it("falls back to the tail when subagent_key names no mode", () => {
		expect(pickBriefModel(LADDER, "nonexistent")?.spec).toBe("openai-codex/gpt-5.6-luna");
	});

	it("follows a retuned ladder without a client change", () => {
		const retuned: AgentMode[] = [
			{ key: "high", model: "vendor/big" },
			{ key: "cheap", model: "vendor/tiny" },
		];
		expect(pickBriefModel(retuned, undefined)).toEqual({ spec: "vendor/tiny", source: "mode:cheap" });
	});

	it("ignores entries that are not provider-qualified", () => {
		const dirty: AgentMode[] = [{ key: "high", model: "openai-codex/gpt-5.6-sol" }, { key: "broken", model: "bare-id" }];
		expect(pickBriefModel(dirty, undefined)?.spec).toBe("openai-codex/gpt-5.6-sol");
	});

	it("stands down on an empty catalog rather than picking anything", () => {
		expect(pickBriefModel([], undefined)).toBeNull();
		expect(pickBriefModel([{ key: "x", model: "bare" }], undefined)).toBeNull();
	});
});
