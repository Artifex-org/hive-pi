import { describe, expect, it } from "vitest";
import { createDeltaQueue } from "../extensions/hive-remote/deltaQueue.ts";

// The bug: deltas went out as independent unawaited POSTs, one per
// message_update. HTTP does not order across requests and the wire carries no
// sequence number, so the server appended them in arrival order and a reply
// mid-stream rendered shuffled — `getThe`wid`, which is the tail of "widget",
// the start of "The" and a fragment of "`wid" reassembled wrong.
//
// These tests use a sender whose completion the test controls, because the race
// only exists while a send is in flight. A sender that resolves immediately
// cannot reproduce it.
function deferredSender() {
	const sent: string[] = [];
	const resolvers: (() => void)[] = [];
	const send = (text: string) => {
		sent.push(text);
		return new Promise<void>((resolve) => resolvers.push(resolve));
	};
	return {
		sent,
		send,
		/** Complete the oldest outstanding send. */
		settle: async () => {
			resolvers.shift()?.();
			await Promise.resolve();
			await Promise.resolve();
		},
	};
}

describe("createDeltaQueue", () => {
	it("keeps ONE send in flight, whatever arrives meanwhile", async () => {
		const s = deferredSender();
		const q = createDeltaQueue(s.send);

		q.push("The ");
		expect(s.sent).toEqual(["The "]); // first goes straight out

		// Everything during the flight waits. Before this fix each of these was
		// its own concurrent request, and any of them could land first.
		q.push("wid");
		q.push("get");
		q.push(" CLI");
		expect(s.sent).toEqual(["The "]);

		await s.settle();
		// Coalesced into ONE request, in order: thirty token deltas become two
		// round trips rather than thirty, and the text is identical because
		// deltas are append-only.
		expect(s.sent).toEqual(["The ", "widget CLI"]);
	});

	it("preserves order across a long burst", async () => {
		const s = deferredSender();
		const q = createDeltaQueue(s.send);
		const chunks = ["a", "b", "c", "d", "e", "f", "g"];
		for (const c of chunks) q.push(c);
		while (s.sent.join("").length < chunks.join("").length) await s.settle();
		expect(s.sent.join("")).toBe("abcdefg");
	});

	// A delta is ephemeral and the durable event supersedes it, so a lost one
	// costs a frame of smooth rendering. Re-queueing would be worse than
	// dropping: it would place the failed text AFTER text since sent, which is
	// the exact reordering this file exists to prevent.
	it("drops a failed batch rather than re-queueing it out of order", async () => {
		const sent: string[] = [];
		let fail = true;
		const q = createDeltaQueue((text) => {
			sent.push(text);
			if (fail) {
				fail = false;
				return Promise.reject(new Error("network"));
			}
			return Promise.resolve();
		});
		q.push("lost");
		await q.idle();
		q.push("kept");
		await q.idle();
		expect(sent).toEqual(["lost", "kept"]);
	});

	it("ignores an empty delta rather than sending a no-op request", async () => {
		const sent: string[] = [];
		const q = createDeltaQueue((t) => {
			sent.push(t);
			return Promise.resolve();
		});
		q.push("");
		await q.idle();
		expect(sent).toEqual([]);
	});

	it("reports idle once the queue has drained", async () => {
		const s = deferredSender();
		const q = createDeltaQueue(s.send);
		q.push("x");
		let done = false;
		void q.idle().then(() => (done = true));
		expect(done).toBe(false);
		await s.settle();
		await q.idle();
		expect(done).toBe(true);
	});
});
