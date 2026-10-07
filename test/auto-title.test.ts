import { describe, expect, it } from "vitest";

import autoTitle, { deriveTitle } from "../extensions/auto-title.ts";
import sessionIdentity from "../extensions/hive-remote/sessionIdentity.ts";
import { REMOTE_OPENING_INPUT_CHANNEL } from "../extensions/hive-remote/sessionIdentityBus.ts";
import { createFakePi } from "./fake-pi.ts";

describe("deriveTitle", () => {
	it("uses the first meaningful line and removes conversational filler", () => {
		expect(deriveTitle("Please fix the flaky Hive API test.\n\nLogs follow."))
			.toBe("fix the flaky Hive API test");
	});

	it("ignores slash commands", () => {
		expect(deriveTitle("/hive-remote-on")).toBeUndefined();
	});

	it("redacts URLs and local paths before a title can reach Hive", () => {
		expect(deriveTitle("Investigate https://example.test/token in ~/repos/private/config.ts"))
			.toBe("Investigate [url] in [path]");
	});

	it("truncates at a word boundary", () => {
		const title = deriveTitle("implement automatic prompt derived titles that remain concise and useful in the Hive agents workspace");
		expect(title).toBe("implement automatic prompt derived titles that remain concise and…");
		expect(title!.length).toBeLessThanOrEqual(72);
	});
});

describe("auto-title extension", () => {
	it("names a session once from its first meaningful user input", async () => {
		const fake = createFakePi();
		autoTitle(fake.api);

		await fake.emit({ type: "session_start", reason: "startup" });
		await fake.emit({ type: "input", text: "/hive-remote-on", source: "interactive" });
		await fake.emit({ type: "input", text: "Plan automatic Pi session naming", source: "interactive" });
		await fake.emit({ type: "input", text: "This follow-up must not replace the title", source: "interactive" });

		expect(fake.sessionNames).toEqual(["Plan automatic Pi session naming"]);
		expect(fake.entries).toEqual([{ customType: "auto-title", data: { assigned: true } }]);
	});

	it("uses a deterministic fallback for image-only input", async () => {
		const fake = createFakePi();
		autoTitle(fake.api);

		await fake.emit({ type: "session_start", reason: "startup" });
		await fake.emit({ type: "input", text: "", images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], source: "interactive" });

		expect(fake.sessionNames).toEqual(["Review attached image"]);
	});

	it("commits automatic title provenance before the SDK name event, never pinning it", async () => {
		const fake = createFakePi();
		sessionIdentity(fake.api);
		autoTitle(fake.api);

		await fake.emit({ type: "session_start", reason: "startup" });
		await fake.emit({ type: "input", text: "Review the attached image", source: "interactive" });
		await fake.emit({ type: "session_info_changed" });

		expect(fake.busEvents.map(event => event.name)).not.toContain("session-identity:manual-title");
		const identity = fake.entries.filter(entry => entry.customType === "session-identity").at(-1)?.data as { title?: string; titlePinned?: boolean };
		expect(identity.title).toBe("Review the attached image");
		expect(identity.titlePinned).not.toBe(true);
	});

	it("titles a trusted remote opening input but ignores unmatched synthetic extension input", async () => {
		const fake = createFakePi();
		autoTitle(fake.api);

		await fake.emit({ type: "session_start", reason: "startup" });
		await fake.emit({ type: "input", text: "Synthetic extension note", source: "extension" });
		fake.api.events.emit(REMOTE_OPENING_INPUT_CHANNEL, { text: "Inspect the attached screenshot" });
		await fake.emit({ type: "input", text: "Inspect the attached screenshot", source: "extension" });
		await fake.emit({ type: "input", text: "Later remote follow-up", source: "extension" });

		expect(fake.sessionNames).toEqual(["Inspect the attached screenshot"]);
	});

	it("preserves an explicit session name", async () => {
		const fake = createFakePi();
		autoTitle(fake.api);
		fake.api.setSessionName("Manual title");

		await fake.emit({ type: "session_start", reason: "startup" });
		await fake.emit({ type: "input", text: "Fix the session title behavior", source: "interactive" });

		expect(fake.sessionNames).toEqual(["Manual title"]);
	});

	it("does not re-title a resumed session that already has an auto-title marker", async () => {
		const fake = createFakePi();
		autoTitle(fake.api);

		await fake.emit(
			{ type: "session_start", reason: "resume" },
			{ branch: [{ type: "custom", customType: "auto-title", data: { assigned: true } }] },
		);
		await fake.emit({ type: "input", text: "Fix the session title behavior", source: "interactive" });

		expect(fake.sessionNames).toEqual([]);
	});
});
