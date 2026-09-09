import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getPackageDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { Credential } from "@earendil-works/pi-ai";

const lockfile: typeof import("proper-lockfile") = createRequire(join(getPackageDir(), "package.json"))("proper-lockfile");

// Use Pi's own locking library and auth-path spelling (realpath:false).
// AuthStorage itself is private to Pi; no private SDK import or replacement
// credential store is needed to exchange one provider under the same lock.
export async function modifyCredential(path: string, provider: string, change: (current: Credential | undefined) => Promise<Credential>): Promise<void> {
	let compromised: Error | undefined;
	const release = await lockfile.lock(path, {
		realpath: false,
		stale: 30_000,
		retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
		onCompromised: (error) => { compromised = error; },
	});
	try {
		const document: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof document !== "object" || document === null || Array.isArray(document)) throw new Error("Invalid session credential document");
		const replacement = await change(readStoredCredential(provider, path));
		if (compromised) throw compromised;
		await writeFile(path, JSON.stringify({ ...document, [provider]: replacement }), { mode: 0o600 });
	} finally { await release(); }
}
