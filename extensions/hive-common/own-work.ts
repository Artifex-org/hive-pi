/**
 * How much of the agent's own asynchronous work is still running — background
 * jobs, CI watchers, durable orchestrations — shared across extensions on the
 * in-process bus (extensions are separate module instances).
 *
 * The hand-back classifier reads "the watcher will deliver the verdict" from
 * prose (`machine`), and the re-entry policies stand down on it, because the
 * completion is what will wake the agent. Prose alone is not enough: a model
 * that writes "will continue once the build finishes" WITHOUT starting a
 * watcher would otherwise park forever where it used to be re-driven. So a
 * `machine` hand-back only counts while something here is actually running.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Handback, NO_HANDBACK } from "./handback.ts";

export const OWN_WORK_CHANNEL = "hive.ownwork";

export interface OwnWorkEvent {
	/** The announcing extension — an enum-like name. */
	by: string;
	/** Its currently running jobs. */
	running: number;
}

export function announceOwnWork(pi: ExtensionAPI, by: string, running: number): void {
	pi.events.emit(OWN_WORK_CHANNEL, { by, running } satisfies OwnWorkEvent);
}

export interface OwnWork {
	running(): number;
}

export function trackOwnWork(pi: ExtensionAPI): OwnWork {
	const counts = new Map<string, number>();
	pi.events.on(OWN_WORK_CHANNEL, (data: unknown) => {
		const event = data as Partial<OwnWorkEvent> | undefined;
		if (typeof event?.by !== "string" || typeof event.running !== "number") return;
		counts.set(event.by, event.running);
	});
	return {
		running: () => {
			let total = 0;
			for (const count of counts.values()) total += count;
			return total;
		},
	};
}

/** A `machine` hand-back with nothing actually running is a plain stop. */
export function confirmOwnWork(handback: Handback, ownWork: OwnWork): Handback {
	return handback.kind === "machine" && ownWork.running() === 0 ? NO_HANDBACK : handback;
}
