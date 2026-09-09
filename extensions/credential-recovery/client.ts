import { request } from "node:http";
import { createHash } from "node:crypto";
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

export function exchange(socketPath: string, provider: string, credential: Credential, failed: boolean): Promise<ExchangeResult> {
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
				if (res.statusCode === 409) { resolve({ status: "exhausted" }); return; }
				if (res.statusCode === 422) { resolve({ status: "unavailable" }); return; }
				if (res.statusCode !== 200) { reject(new Error(`Credential exchange failed (HTTP ${res.statusCode})`)); return; }
				try {
					const doc: unknown = JSON.parse(body);
					if (typeof doc !== "object" || doc === null || Object.keys(doc).length !== 1 || !(provider in doc)) {
						throw new Error("Credential exchange returned a different provider");
					}
					resolve({ status: "recovered", credential: parseCredential(Reflect.get(doc, provider)) });
				} catch (error) { reject(error); }
			});
		});
		req.setTimeout(35_000, () => req.destroy(new Error("Credential exchange timed out")));
		req.on("error", reject);
		req.end(JSON.stringify({ provider, credential, failed }));
	});
}
