/** Durable one-attempt latch. Never remove it to retry a failed pilot. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { validateStateRoot, type LaunchConfig } from "./runtime.ts";

export async function claimPilotAttempt(config: Pick<LaunchConfig, "stateRoot" | "launch">): Promise<void> {
	if (!/^[a-zA-Z0-9_-]+$/.test(config.launch)) throw new Error("Invalid pilot launch identity");
	await validateStateRoot(config.stateRoot);
	const file = await open(join(config.stateRoot, `pilot-${config.launch}.attempt`),
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	try { await file.writeFile('{"protocol":1,"consumed":true}\n'); await file.sync(); }
	finally { await file.close(); }
	// Persist the directory entry too: a process restart must not refund it.
	const directory = await open(config.stateRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { await directory.sync(); } finally { await directory.close(); }
}
