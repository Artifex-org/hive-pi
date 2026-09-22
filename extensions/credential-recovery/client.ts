import { request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";

export type ExchangeResult = { status: "recovered"; credential: Credential } | { status: "exhausted" | "unavailable" };

export function identity(credential: Credential): string {
	if (credential.type === "oauth" && typeof credential.accountId === "string") return credential.accountId;
	if (credential.type === "api_key" && credential.key) return createHash("sha256").update(credential.key).digest("hex");
	if (credential.type === "oauth") return createHash("sha256").update(credential.access).digest("hex");
	throw new Error("Credential has no account or token identity");
}

function parseCredential(value: unknown): Credential {
	if (typeof value !== "object" || value === null) throw new Error("Invalid replacement credential");
	if ("type" in value && value.type === "api_key" && "key" in value && typeof value.key === "string") {
		return { ...value, type: "api_key", key: value.key };
	}
	if ("type" in value && value.type === "oauth" && "access" in value && typeof value.access === "string" &&
		"refresh" in value && typeof value.refresh === "string" && "expires" in value && typeof value.expires === "number") {
		return { ...value, type: "oauth", access: value.access, refresh: value.refresh, expires: value.expires };
	}
	throw new Error("Invalid replacement credential");
}

/**
 * Where the lease holder answers exchanges. `socket` is the original transport;
 * `mailbox` carries the identical exchange through files in the launch's pi dir
 * for a sandboxed agent, whose srt seccomp filter blocks socket(AF_UNIX) outright
 * (HIV-3452). Both are served by the same Go handler (pilease exchangeResponse),
 * so the statuses below mean the same thing on either.
 */
export type Transport = { kind: "socket"; path: string } | { kind: "mailbox"; dir: string };

/** Map one exchange answer onto the result, whichever transport carried it. */
function interpret(status: number, provider: string, doc: unknown): ExchangeResult {
	if (status === 409) return { status: "exhausted" };
	if (status === 422) return { status: "unavailable" };
	if (status !== 200) throw new Error(`Credential exchange failed (HTTP ${status})`);
	if (typeof doc !== "object" || doc === null || Object.keys(doc).length !== 1 || !(provider in doc)) {
		throw new Error("Credential exchange returned a different provider");
	}
	return { status: "recovered", credential: parseCredential(Reflect.get(doc, provider)) };
}

export function exchange(transport: Transport, provider: string, credential: Credential, failed: boolean): Promise<ExchangeResult> {
	return transport.kind === "mailbox"
		? exchangeViaMailbox(transport.dir, provider, credential, failed)
		: exchangeViaSocket(transport.path, provider, credential, failed);
}

function exchangeViaSocket(socketPath: string, provider: string, credential: Credential, failed: boolean): Promise<ExchangeResult> {
	return new Promise((resolve, reject) => {
		const req = request({ socketPath, path: "/exchange", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				body += chunk;
				if (body.length > 1_048_576) req.destroy(new Error("Credential response exceeds size limit"));
			});
			res.on("error", reject);
			res.on("end", () => {
				try {
					const status = res.statusCode ?? 0;
					resolve(interpret(status, provider, status === 200 ? JSON.parse(body) : undefined));
				} catch (error) { reject(error); }
			});
		});
		req.setTimeout(35_000, () => req.destroy(new Error("Credential exchange timed out")));
		req.on("error", reject);
		req.end(JSON.stringify({ provider, credential, failed }));
	});
}

/**
 * The file transport: publish `<id>.req` atomically (write a temp, rename), then
 * wait for the lease holder's `<id>.resp`. The holder polls every 250ms and the
 * exchange itself is bounded at 30s server-side, so 35s matches the socket.
 */
export async function exchangeViaMailbox(
	dir: string, provider: string, credential: Credential, failed: boolean,
	opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ExchangeResult> {
	const timeoutMs = opts.timeoutMs ?? 35_000;
	const pollMs = opts.pollMs ?? 100;
	const id = randomUUID();
	const request = join(dir, `${id}.req`);
	const response = join(dir, `${id}.resp`);
	await writeFile(`${request}.tmp`, JSON.stringify({ provider, credential, failed }), { mode: 0o600, flag: "wx" });
	await rename(`${request}.tmp`, request);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let text: string | undefined;
		try { text = await readFile(response, "utf8"); } catch { /* not answered yet */ }
		if (text !== undefined) {
			await rm(response, { force: true });
			const reply: unknown = JSON.parse(text);
			if (typeof reply !== "object" || reply === null || typeof Reflect.get(reply, "status") !== "number") {
				throw new Error("Invalid credential exchange response");
			}
			return interpret(Reflect.get(reply, "status") as number, provider, Reflect.get(reply, "document"));
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	// Withdraw an unclaimed request so a late holder does not act on it.
	await rm(request, { force: true });
	throw new Error("Credential exchange timed out (recovery mailbox)");
}
