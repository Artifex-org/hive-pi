/**
 * explore — the wiring, asserted against a fake pi.
 *
 * Two properties here are the inverse of `btw.test.ts`'s, and the contrast is the
 * point of both files. btw asserts that NOTHING reaches the session; explore
 * asserts that the record does — via `appendEntry`, and only via `appendEntry`.
 * `sendMessage`/`sendUserMessage` must stay empty in every test: an exploration
 * that pushed its purpose into the conversation would spend context on
 * bookkeeping and steer the very turn it is trying to stay out of.
 *
 * The other property is that the command keeps NO state of its own. Every test
 * that spans two invocations feeds the previously appended entries back in as the
 * session's entries, which is what pi does; one of them goes further and hands
 * them to a SECOND, freshly wired extension, because a closure cache would pass
 * the first shape of that test and fail the second.
 */

import { describe, expect, it } from "vitest";

import { createFakePi, type FakePi } from "./fake-pi.ts";
import explore from "../extensions/explore/index.ts";

/** A wired extension with nothing in it yet. */
function harness(): FakePi {
	const fake = createFakePi();
	explore(fake.api);
	return fake;
}

type BranchEntry = NonNullable<Parameters<FakePi["runCommand"]>[2]>["branch"];

/**
 * Run `/explore`, handing it back everything it has already written.
 *
 * This is the whole reason the command can be stateless: pi's session manager
 * returns the appended entries, so replaying them here is faithful rather than
 * convenient. `extra` injects transcript entries (tool calls) for the tests that
 * care what the report can see.
 */
async function run(fake: FakePi, args: string, extra: BranchEntry = []): Promise<void> {
	const written = fake.entries.map((entry) => ({ customType: entry.customType, data: entry.data }));
	await fake.runCommand("explore", args, { branch: [...(extra ?? []), ...written] });
}

function lastNotification(fake: FakePi): { message: string; type?: string } {
	const notification = fake.notifications.at(-1);
	if (!notification) throw new Error("expected a notification");
	return notification;
}

/** An assistant turn that edited a file, stamped after the exploration opened. */
function edited(path: string, timestamp: number): BranchEntry {
	return [
		{
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { file_path: path } }],
				// The fake's branch type does not model `timestamp`, so it rides along
				// on the message object the extension actually reads.
				...({ timestamp } as Record<string, unknown>),
			},
		},
	] as BranchEntry;
}

describe("registration", () => {
	it("registers /explore", () => {
		expect(harness().commands.has("explore")).toBe(true);
	});

	// pi awaits handlers serially, and there is nothing about an exploration to
	// observe per message. Registering none also makes the forbidden-event rule
	// trivially satisfied rather than narrowly avoided.
	it("registers no event handlers at all", () => {
		expect([...harness().handlers.keys()]).toEqual([]);
	});
});

describe("/explore <purpose>", () => {
	it("persists exactly one snapshot and writes nothing to the conversation", async () => {
		const fake = harness();
		await run(fake, "does the retry belong in the client?");

		expect(fake.entries).toHaveLength(1);
		expect(fake.entries[0]?.customType).toBe("explore");
		// The inverse of btw: the record is the deliverable, but it must reach the
		// session file only — never the model's context.
		expect(fake.messages).toEqual([]);
		expect(fake.userMessages).toEqual([]);
	});

	// The nudge half of the feature. If this line ever disappears, `/explore`
	// becomes a bookkeeping command that never tells anyone what to do next.
	it("tells the operator which pi command to type next", async () => {
		const fake = harness();
		await run(fake, "why is the 429 path silent?");
		const message = lastNotification(fake).message;
		expect(message).toContain("why is the 429 path silent?");
		expect(message).toContain("/tree");
		expect(message).toContain("/fork");
		expect(message).toContain("does not move you");
	});

	// The fake's session manager has no `getLeafId`, exactly like an unpersisted
	// session. Losing the purpose over a missing citation would be the wrong trade.
	it("opens even when the session cannot name an entry id", async () => {
		const fake = harness();
		await run(fake, "p");
		expect(fake.entries).toHaveLength(1);
		expect(lastNotification(fake).message).toContain("no entry to cite");
	});

	// A fat-fingered `/explore ` must not open an exploration with no purpose —
	// the thing this extension exists to prevent. The parser makes that
	// structurally impossible by reading a whitespace-only argument as a listing,
	// so the pure `empty-purpose` refusal (covered in explore-state.test.ts) is
	// unreachable from here. This test pins the parser side of that guarantee.
	it("treats a whitespace-only argument as a listing, never an unnamed exploration", async () => {
		const fake = harness();
		await fake.runCommand("explore", "   ");
		expect(fake.entries).toEqual([]);
		expect(lastNotification(fake).message).toContain("nothing explored");
	});

	// STARTING TWICE, through the command: the refusal must not append a snapshot,
	// and it has to say what is already open.
	it("refuses a second exploration and quotes the open one", async () => {
		const fake = harness();
		await run(fake, "first purpose");
		await run(fake, "second purpose");

		expect(fake.entries).toHaveLength(1);
		const notification = lastNotification(fake);
		expect(notification.type).toBe("error");
		expect(notification.message).toContain("first purpose");
		expect(notification.message).toContain("/explore done");
	});
});

describe("/explore done", () => {
	it("collapses to a report: purpose, duration and the conclusion, with no model call", async () => {
		const fake = harness();
		await run(fake, "does the retry belong in the client?");
		await run(fake, "done no — the caller owns it");

		expect(fake.entries).toHaveLength(2);
		const message = lastNotification(fake).message;
		expect(message).toContain("does the retry belong in the client?");
		expect(message).toContain("no — the caller owns it");
		// Nothing in this path may reach a provider: the report is assembled from
		// what the operator typed and what the session already holds. A fake pi has
		// no model, so a close that tried would have thrown — but the explicit
		// assertion is that no message was ever sent to one.
		expect(fake.messages).toEqual([]);
	});

	it("names the files the exploration changed", async () => {
		const fake = harness();
		await run(fake, "find the leak");
		await run(fake, "done it was the pool", edited("src/pool.ts", Date.now() + 1_000));
		expect(lastNotification(fake).message).toContain("src/pool.ts");
	});

	// CLOSING WITHOUT STARTING.
	it("refuses when nothing is open and appends nothing", async () => {
		const fake = harness();
		await run(fake, "done whatever");
		expect(fake.entries).toEqual([]);
		expect(lastNotification(fake).type).toBe("error");
	});

	// CLOSING TWICE. The second must not append a snapshot — a re-close would
	// silently rewrite the finished exploration's duration.
	it("refuses a second close", async () => {
		const fake = harness();
		await run(fake, "p");
		await run(fake, "done first conclusion");
		await run(fake, "done second conclusion");

		expect(fake.entries).toHaveLength(2);
		expect(lastNotification(fake).type).toBe("error");
	});

	it("closes with no conclusion at all", async () => {
		const fake = harness();
		await run(fake, "p");
		await run(fake, "done");
		expect(fake.entries).toHaveLength(2);
		expect(lastNotification(fake).message).toContain("without a conclusion");
	});
});

describe("/explore", () => {
	it("lists what this session explored, answers included", async () => {
		const fake = harness();
		await run(fake, "first question");
		await run(fake, "done answered in the affirmative");
		await run(fake, "second question");
		await run(fake, "");

		const message = lastNotification(fake).message;
		expect(message).toContain("first question");
		expect(message).toContain("answered in the affirmative");
		expect(message).toContain("[open] second question");
	});

	it("says nothing has been explored, and teaches the command", async () => {
		const fake = harness();
		await run(fake, "");
		expect(fake.entries).toEqual([]);
		expect(lastNotification(fake).message).toContain("nothing explored");
	});
});

describe("durability", () => {
	/**
	 * The property the whole persistence choice exists for: the record lives in the
	 * session, not in the extension. A second extension instance — which is what a
	 * resume, a fork or a `/reload` produces — must be able to close an exploration
	 * the first one opened, from the entries alone.
	 *
	 * A closure cache would pass every other test in this file and fail this one.
	 */
	it("lets a freshly wired extension close an exploration it never opened", async () => {
		const first = harness();
		await run(first, "survive the reload");

		const reloaded = harness();
		await reloaded.runCommand("explore", "done it survived", {
			branch: first.entries.map((entry) => ({ customType: entry.customType, data: entry.data })),
		});

		expect(reloaded.entries).toHaveLength(1);
		const message = lastNotification(reloaded).message;
		expect(message).toContain("survive the reload");
		expect(message).toContain("it survived");
	});
});
