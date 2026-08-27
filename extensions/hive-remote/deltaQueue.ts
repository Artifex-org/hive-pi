/**
 * hive-remote — sending stream deltas IN ORDER.
 *
 * ## The bug this exists to prevent
 *
 * A delta was sent as its own unawaited HTTP POST, one per `message_update`:
 *
 *     setTimeout(() => { void postDelta(auth, session, delta.text, channel) }, 0)
 *
 * At token cadence that is dozens of overlapping requests, and **HTTP gives no
 * ordering across separate requests**. The wire carries no sequence number and
 * the server appends whatever arrives in arrival order, so the browser rendered
 * the fragments shuffled: a reply mid-stream read `famThe\`as` — the tail of
 * "borealis", the start of "The", and a fragment of "`as" — reassembled wrong.
 *
 * That looked exactly like the earlier garble (partial Markdown parsed as a
 * finished document, fixed by rendering in-flight text literally), which is why
 * it survived that fix: same symptom, different half of the pipeline. The other
 * fix was about how the text was DRAWN. This one is about the text being wrong
 * before it ever reaches the browser.
 *
 * ## Why serialize rather than number
 *
 * A sequence number needs the server to buffer and reorder, and a reorder buffer
 * needs a policy for the frame that never comes. Keeping ONE request in flight
 * removes the race instead of compensating for it, and needs no protocol change,
 * no server change, and nothing to tune.
 *
 * ## Coalescing comes free, and is the larger win
 *
 * While a POST is in flight, later deltas accumulate into one string and go out
 * as a SINGLE next request. So a burst of thirty token deltas becomes two round
 * trips rather than thirty, and the text is identical either way — deltas are
 * append-only, so concatenating adjacent ones is exactly what the receiver would
 * have done. Latency is bounded by one request, not by the queue.
 *
 * PER CHANNEL, not global: reasoning and answer are separate buffers on the
 * browser side, so ordering only has to hold within each. One queue for both
 * would make the answer wait behind reasoning it does not depend on.
 */

/** Sends one accumulated chunk. Resolves when the server has it. */
export type DeltaSender = (text: string) => Promise<unknown>;

export interface DeltaQueue {
	/** Queue text for sending. Returns immediately; never rejects. */
	push(text: string): void;
	/** Resolves when nothing is queued or in flight — for tests and shutdown. */
	idle(): Promise<void>;
}

export function createDeltaQueue(send: DeltaSender): DeltaQueue {
	let pending = "";
	let inFlight = false;
	let idleWaiters: (() => void)[] = [];

	function settleIfIdle() {
		if (inFlight || pending !== "") return;
		const waiters = idleWaiters;
		idleWaiters = [];
		for (const w of waiters) w();
	}

	function pump() {
		if (inFlight || pending === "") return;
		const batch = pending;
		pending = "";
		inFlight = true;
		const done = () => {
			inFlight = false;
			if (pending !== "") pump();
			else settleIfIdle();
		};
		// SYNCHRONOUSLY, not off a microtask: the first token of a turn should
		// leave as soon as it arrives, and deferring it adds a tick of latency to
		// every stream for nothing.
		//
		// The send is never allowed to reject the caller: a delta is ephemeral and
		// the durable event supersedes it, so a lost one costs a frame of smooth
		// rendering and nothing else. Dropping the batch on failure is deliberate —
		// re-queueing it would put it AFTER text that has since been sent, which is
		// the very reordering this file exists to prevent. A sender that throws
		// synchronously is caught here too, or the queue would wedge with
		// `inFlight` stuck true and never send again.
		try {
			void Promise.resolve(send(batch)).catch(() => {}).finally(done);
		} catch {
			done();
		}
	}

	return {
		push(text: string) {
			if (!text) return;
			pending += text;
			pump();
		},
		idle() {
			if (!inFlight && pending === "") return Promise.resolve();
			return new Promise<void>((resolve) => idleWaiters.push(resolve));
		},
	};
}
