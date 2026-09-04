/**
 * Reading the posture set an `opmode` build announces.
 *
 * Split out of the subscriber so the validation is testable on its own. The
 * ORDERING in the subscriber matters just as much and cannot be captured here:
 * this must be read BEFORE the unchanged-mode early return, because the set is
 * a property of the build rather than of the current posture.
 */

import type { OpModeStateEvent } from "../hive-common/channels.ts";

/**
 * The announced set, or undefined when the event carries none we can trust.
 *
 * Undefined rather than `[]` on every rejection, and the caller keeps its
 * previous value rather than clearing: an empty set on the wire reads as "this
 * client enforces no postures at all", which would make the server withhold
 * every mode from a client that enforces all of them. Silence and "none" are
 * different answers and must not collapse into one.
 */
export function readAnnouncedModes(event: OpModeStateEvent | undefined): readonly string[] | undefined {
	const announced = event?.modes;
	if (!Array.isArray(announced) || announced.length === 0) return undefined;
	if (!announced.every((mode) => typeof mode === "string" && mode.length > 0)) return undefined;
	return [...announced];
}
