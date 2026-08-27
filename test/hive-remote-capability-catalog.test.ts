import { describe, expect, it } from "vitest";
import {
	buildCatalog,
	MAX_CATALOG_DESCRIPTION,
	MAX_CATALOG_ENTRIES,
	MAX_CATALOG_MODEL_ID,
	MAX_CATALOG_MODELS,
	MAX_CATALOG_NAME,
} from "../extensions/hive-remote/client.ts";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

function command(name: string, source: SlashCommandInfo["source"], description?: string): SlashCommandInfo {
	return {
		name,
		description,
		source,
		sourceInfo: { source, scope: "user", origin: "top-level", path: "/private/path" },
	};
}

describe("buildCatalog", () => {
	it("retains only the command metadata safe to display in Hive", () => {
		const catalog = buildCatalog([
			command("check", "prompt", "Run the local gate"),
			command("skill:debug", "skill", "Debug a failed run"),
		]);

		expect(catalog).toEqual({
			commands: [
				{ name: "check", description: "Run the local gate", source: "prompt" },
				{ name: "skill:debug", description: "Debug a failed run", source: "skill" },
			],
		});
		expect(JSON.stringify(catalog)).not.toContain("/private/path");
	});

	it("bounds the attach payload", () => {
		const commands = Array.from({ length: MAX_CATALOG_ENTRIES + 1 }, (_, i) => command(`cmd-${i}`, "extension"));
		expect(buildCatalog(commands).commands).toHaveLength(MAX_CATALOG_ENTRIES);
	});

	// The regression this whole file's length handling exists for (HIV-1163).
	//
	// A skill's description is frontmatter prose aimed at model dispatch, not a UI
	// label, so thousands of characters is ORDINARY — 12 of 22 skills on the
	// machine this was found on exceeded Hive's 500-byte cap. Sending one whole
	// made the server reject the entire attach, and every session on that
	// workstation lost its conversation: no transcript, no steer, no interrupt,
	// silently retried every two seconds forever.
	it("truncates a skill description rather than letting it fail the attach", () => {
		const prose = "Use this skill when auditing the portfolio. ".repeat(60); // ~2.6k chars
		expect(prose.length).toBeGreaterThan(MAX_CATALOG_DESCRIPTION);

		const [entry] = buildCatalog([command("skill:borealis-audit", "skill", prose)]).commands;

		expect(entry.description).toHaveLength(MAX_CATALOG_DESCRIPTION);
		expect(prose.startsWith(entry.description!)).toBe(true);
		expect(entry.name).toBe("skill:borealis-audit");
	});

	it("truncates an over-long name", () => {
		const name = "x".repeat(MAX_CATALOG_NAME + 50);
		expect(buildCatalog([command(name, "extension")]).commands[0].name).toHaveLength(MAX_CATALOG_NAME);
	});

	it("leaves a missing description absent rather than inventing an empty one", () => {
		expect(buildCatalog([command("check", "prompt")]).commands[0].description).toBeUndefined();
	});

	// Truncation must never split a character. Postgres refuses invalid UTF-8 in a
	// jsonb column, so a half-written rune would turn this fix back into the
	// failed attach it exists to prevent.
	it("truncates on character boundaries, counting bytes", () => {
		const description = "あ".repeat(400); // 3 bytes each: 1200 bytes, no multiple of 3 hits 500
		const [entry] = buildCatalog([command("check", "prompt", description)]).commands;

		expect(Buffer.byteLength(entry.description!, "utf8")).toBeLessThanOrEqual(MAX_CATALOG_DESCRIPTION);
		expect(entry.description).toBe("あ".repeat(166)); // 498 bytes; a 167th would overrun
		expect(entry.description).not.toContain("�");
	});

	// The models this machine can run, for the workspace's "Custom…" row
	// (HIV-1800). Reported from HERE because this is the only side that knows —
	// Hive's mode config is fleet-wide and need not match any one workstation.
	it("reports the registry as provider/id", () => {
		const catalog = buildCatalog([], [
			{ provider: "anthropic", id: "claude-opus-5" },
			{ provider: "openrouter", id: "z-ai/glm-5.2" },
		]);

		// The openrouter id carries its own slash and must survive whole: the
		// server splits on the FIRST one, so this round-trips.
		expect(catalog.models).toEqual(["anthropic/claude-opus-5", "openrouter/z-ai/glm-5.2"]);
	});

	// Absent and empty are different claims. "This client did not say" leaves the
	// browser's field open to free text; `[]` would be this machine asserting it
	// can run no models at all.
	it("omits the key entirely when there is nothing to report", () => {
		expect("models" in buildCatalog([command("check", "prompt")])).toBe(false);
		expect("models" in buildCatalog([], [])).toBe(false);
	});

	it("drops registry entries that could not round-trip, and duplicates", () => {
		const catalog = buildCatalog([], [
			{ provider: "anthropic", id: "claude-opus-5" },
			{ provider: "anthropic", id: "claude-opus-5" },
			// A provider with a slash cannot be split back apart by the server.
			{ provider: "open/router", id: "glm-5.2" },
			{ provider: "", id: "orphan" },
			{ provider: "anthropic", id: "" },
			{ provider: "anthropic", id: "x".repeat(MAX_CATALOG_MODEL_ID) },
		]);

		expect(catalog.models).toEqual(["anthropic/claude-opus-5"]);
	});

	it("bounds the model list like every other part of the payload", () => {
		const models = Array.from({ length: MAX_CATALOG_MODELS + 5 }, (_, i) => ({
			provider: "openrouter",
			id: `model-${i}`,
		}));
		expect(buildCatalog([], models).models).toHaveLength(MAX_CATALOG_MODELS);
	});

	it("does not split a surrogate pair", () => {
		// 4 bytes each. 125 emoji = 500 bytes exactly, so the cap lands ON a
		// boundary here — the failure mode being pinned is a lone surrogate from a
		// naive .slice(), which would still be 500 "characters" by String.length.
		const description = "🐝".repeat(200);
		const [entry] = buildCatalog([command("check", "prompt", description)]).commands;

		expect(Buffer.byteLength(entry.description!, "utf8")).toBeLessThanOrEqual(MAX_CATALOG_DESCRIPTION);
		expect(entry.description).toBe("🐝".repeat(125));
		expect([...entry.description!].every((ch) => ch === "🐝")).toBe(true);
	});
});
