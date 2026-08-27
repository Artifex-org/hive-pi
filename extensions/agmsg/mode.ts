/**
 * Delivery mode, as agmsg records it for this project.
 *
 * agmsg's model is deliberately PER PROJECT, not per machine and not per
 * session: the same developer wants push delivery in the repo where a team is
 * working and nothing at all in the scratch directory next to it. Every agent
 * type stores that in a project-relative file its manifest names (`hooks_file`);
 * for `pi` that file is `.pi/agmsg.json` and this module is its only reader.
 * The writer is the driver's `_delivery.sh`, invoked by `agmsg delivery set`.
 *
 * ABSENT MEANS OFF. That is the same rule every other type follows (a
 * claude-code project without agmsg hooks in settings.local.json is off), and
 * it is what keeps an un-joined project free: no file, no watcher, no cost.
 * Defaulting to "monitor because an identity exists" would start a background
 * process in projects where the user only ever wanted to send.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `both` exists for claude-code (Monitor tool AND Stop hook) and is deliberately
 * NOT offered here: pi's watcher injects into idle sessions by itself, so the
 * turn-based poll it would run alongside can only produce doubles.
 */
export type DeliveryMode = "monitor" | "turn" | "off";

export const DELIVERY_FILE = join(".pi", "agmsg.json");

export function deliveryFilePath(project: string): string {
	return join(project, DELIVERY_FILE);
}

export function parseMode(raw: string): DeliveryMode {
	try {
		const mode = (JSON.parse(raw) as { mode?: unknown }).mode;
		if (mode === "monitor" || mode === "turn" || mode === "off") return mode;
		return "off";
	} catch {
		// A hand-edited file with a trailing comma is a mode nobody can read, and
		// the safe reading of "unreadable" is the one that starts nothing.
		return "off";
	}
}

export function readDeliveryMode(project: string): DeliveryMode {
	try {
		return parseMode(readFileSync(deliveryFilePath(project), "utf8"));
	} catch {
		return "off";
	}
}
