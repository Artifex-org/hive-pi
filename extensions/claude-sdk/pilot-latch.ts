/** Durable one-attempt latch. Never remove it to retry a failed pilot. */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { validateStateRoot, type LaunchConfig } from "./runtime.ts";

async function ownedHandle(file: FileHandle, signal: AbortSignal | undefined, work: () => Promise<void>): Promise<void> {
	let closing: Promise<void> | undefined;
	let closeFailed = false;
	const close = () => closing ??= file.close();
	const abort = () => { void close().catch(() => { closeFailed = true; }); };
	signal?.addEventListener("abort", abort, { once: true });
	try {
		if (signal?.aborted) abort();
		await work();
	} finally {
		signal?.removeEventListener("abort", abort);
		// Keep ownership of the cached close, including a failure observed by
		// the abort listener while write/sync was still outstanding.
		await close();
		if (closeFailed) throw new Error("Pilot latch close failed");
	}
}

export async function claimPilotAttempt(config: Pick<LaunchConfig, "stateRoot" | "launch">,
	onClaimed: () => void = () => {}, signal?: AbortSignal): Promise<void> {
	if (!/^[a-zA-Z0-9_-]+$/.test(config.launch)) throw new Error("Invalid pilot launch identity");
	signal?.throwIfAborted();
	await validateStateRoot(config.stateRoot);
	signal?.throwIfAborted();
	const file = await open(join(config.stateRoot, `pilot-${config.launch}.attempt`),
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	await ownedHandle(file, signal, async () => {
		// Exclusive creation consumes the attempt, even if subsequent write,
		// sync or close fails. Report ownership before those awaits.
		onClaimed();
		signal?.throwIfAborted();
		await file.writeFile('{"protocol":1,"consumed":true}\n');
		signal?.throwIfAborted();
		await file.sync();
	});
	signal?.throwIfAborted();
	// Persist the directory entry too: a process restart must not refund it.
	const directory = await open(config.stateRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	await ownedHandle(directory, signal, async () => { signal?.throwIfAborted(); await directory.sync(); });
}
