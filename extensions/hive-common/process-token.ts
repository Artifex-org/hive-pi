/**
 * A name for THIS pi process that no other process shares.
 *
 * `process.pid` is not one. Every sandboxed session runs in its own srt PID
 * namespace, where pi is pid 2, and their temp dirs are shared — so two
 * sandboxed sessions keyed a temp path on the pid got the SAME path, and one
 * session's cleanup deleted the other's live copy (`pi-browser-2` serving
 * another session's screenshots is how it surfaced, 2026-10-02).
 *
 * Held on `globalThis` under a registered symbol, not in a module variable or
 * the environment:
 *   - pi loads each extension with its own module instance, so a module-level
 *     constant would give two extensions of one process two different names
 *     for the same process — and one extension's cleanup would miss the
 *     other's files;
 *   - the environment is inherited, so a worker would claim its parent's name
 *     and its shutdown would delete the parent's files.
 */

import { randomUUID } from "node:crypto";

const KEY = Symbol.for("hive-pi.process-token");

export function processToken(): string {
	const store = globalThis as unknown as Record<symbol, string | undefined>;
	store[KEY] ??= `${process.pid}-${randomUUID().slice(0, 8)}`;
	return store[KEY];
}
