import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export interface ReceivedCredential { name: string; env_var: string; value: string }
export interface CredentialBinding { localSessionID: string; hiveSessionID: string; generation: number }
interface SessionGrant { expiresAt: number; credentials: ReceivedCredential[]; timer: NodeJS.Timeout }
interface BoundSession { binding: CredentialBinding; grants: Map<string, SessionGrant> }
interface Runtime { sessions: Map<string, BoundSession>; consumers: Map<string, Set<object>> }
// Extensions are loaded through separate jiti instances. Module-local state is
// not a cross-extension bus; this process-local symbol is the single registry.
const key = Symbol.for("hive.pi.credential-runtime.v1");
const shared = globalThis as typeof globalThis & { [key]?: Runtime };
const runtime = shared[key] ??= { sessions: new Map(), consumers: new Map() };
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_SECRETS = 32;
const RESERVED_ENV = /^(?:PATH$|HOME$|SHELL$|PWD$|OLDPWD$|TMPDIR$|TEMP$|TMP$|NODE_|LD_|DYLD_|BASH_|ENV$|BASH_ENV$|IFS$|PI_|HIVE_|ANTHROPIC_|OPENAI_|OPENROUTER_|GEMINI_|AWS_|GOOGLE_|AZURE_|CODEX_|XDG_|PYTHON|PERL|RUBY|JAVA_|JDK_|GIT_|SSH_|GOPROXY$|GOTOOLCHAIN$|RUSTUP_|CARGO_|NPM_|npm_|ZDOTDIR$|FPATH$|CDPATH$|SHELLOPTS$|BASHOPTS$)/i;

export function validCredentialSet(items: ReceivedCredential[]): boolean {
	if (!items.length || items.length > MAX_SECRETS) return false;
	const names = new Set<string>(), envs = new Set<string>();
	return items.every((item) => {
		if (!item || typeof item.name !== "string" || typeof item.env_var !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.name) ||
			!/^[_A-Za-z][_A-Za-z0-9]{0,127}$/.test(item.env_var) || RESERVED_ENV.test(item.env_var) ||
			typeof item.value !== "string" || !item.value || item.value.includes("\0") || Buffer.from(item.value).toString("utf8") !== item.value || Buffer.byteLength(item.value) > MAX_SECRET_BYTES ||
			names.has(item.name) || envs.has(item.env_var)) return false;
		names.add(item.name); envs.add(item.env_var); return true;
	});
}

export function registerCredentialConsumer(name: "bash" | "background"): () => void {
	const token = {};
	let consumers = runtime.consumers.get(name);
	if (!consumers) runtime.consumers.set(name, consumers = new Set());
	consumers.add(token);
	return () => { consumers.delete(token); };
}
export function hasCredentialConsumer(name: "bash" | "background"): boolean {
	return (runtime.consumers.get(name)?.size ?? 0) > 0;
}
export function bindCredentialSession(localSessionID: string, hiveSessionID: string, generation: number): CredentialBinding {
	const binding = Object.freeze({ localSessionID, hiveSessionID, generation });
	const previous = runtime.sessions.get(localSessionID);
	if (previous) for (const grant of previous.grants.values()) clearTimeout(grant.timer);
	runtime.sessions.set(localSessionID, { binding, grants: new Map() });
	return binding;
}
export function isCredentialBindingCurrent(binding: CredentialBinding): boolean {
	return runtime.sessions.get(binding.localSessionID)?.binding === binding;
}
export function installCredentialGrant(binding: CredentialBinding, grantID: string, expiresAt: number, items: ReceivedCredential[]): boolean {
	if (!isCredentialBindingCurrent(binding) || !grantID || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt - Date.now() > 2_147_483_647 || !validCredentialSet(items)) return false;
	const state = runtime.sessions.get(binding.localSessionID)!;
	// Bound memory and redaction costs across repeated requests, not just each grant.
	const combined = activeCredentials(binding.localSessionID).filter(item => !items.some(next => next.env_var === item.env_var));
	if (combined.length + items.length > MAX_SECRETS || state.grants.size >= MAX_SECRETS) return false;
	const previous = state.grants.get(grantID);
	if (previous) clearTimeout(previous.timer);
	const grant: SessionGrant = {
		expiresAt, credentials: items.map(item => ({ ...item })),
		timer: setTimeout(() => { if (state.grants.get(grantID) === grant) state.grants.delete(grantID); }, Math.max(1, expiresAt - Date.now())),
	};
	grant.timer.unref();
	state.grants.set(grantID, grant);
	return true;
}
function activeCredentials(sessionID: string | undefined): ReceivedCredential[] {
	const state = sessionID ? runtime.sessions.get(sessionID) : undefined;
	if (!state) return [];
	const items = new Map<string, ReceivedCredential>();
	for (const [id, grant] of state.grants) {
		if (grant.expiresAt <= Date.now()) { clearTimeout(grant.timer); state.grants.delete(id); continue; }
		for (const item of grant.credentials) items.set(item.env_var, item);
	}
	return [...items.values()];
}
export function credentialChildEnv(sessionID: string | undefined, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...base };
	for (const item of activeCredentials(sessionID)) env[item.env_var] = item.value;
	return env;
}

/** Literal accidental-output protection, NOT containment of arbitrary shell code.
 * Each child owns a snapshot so detach/expiry cannot expose its later output. */
export class LiteralSecretRedactor {
	private readonly decoder = new StringDecoder("utf8");
	private carry = "";
	private readonly secrets: string[];
	constructor(secrets: string[]) {
		this.secrets = [...new Set(secrets.filter(secret => secret && Buffer.byteLength(secret) <= MAX_SECRET_BYTES))].sort((a,b) => b.length-a.length);
	}
	push(chunk: Buffer): Buffer { this.carry += this.decoder.write(chunk); return this.consume(false); }
	flush(): Buffer { this.carry += this.decoder.end(); return this.consume(true); }
	private consume(final: boolean): Buffer {
		const output: string[] = [];
		while (this.carry) {
			// Hold an incomplete prefix, including a short match that might grow
			// into a longer overlapping secret on the next chunk.
			if (!final && this.secrets.some(secret => secret.length > this.carry.length && secret.startsWith(this.carry))) break;
			const match = this.secrets.find(secret => this.carry.startsWith(secret));
			if (match) { output.push("[credential redacted]"); this.carry = this.carry.slice(match.length); continue; }
			const character = String.fromCodePoint(this.carry.codePointAt(0)!);
			output.push(character); this.carry = this.carry.slice(character.length);
		}
		return Buffer.from(output.join(""));
	}
}
export function credentialRedactor(sessionID: string | undefined): LiteralSecretRedactor {
	return new LiteralSecretRedactor(activeCredentials(sessionID).map(item => item.value));
}
/** Snapshot environment and both stream/combined redactors atomically. The SDK
 * local backend installs onData directly on stdout/stderr Readable emitters;
 * EventEmitter supplies that stream as `this`. PTY callbacks have one stream. */
export function credentialChildState(sessionID: string | undefined, base: NodeJS.ProcessEnv) {
	const items = activeCredentials(sessionID);
	const env = { ...base };
	for (const item of items) env[item.env_var] = item.value;
	const secrets = items.map(item => item.value);
	const streams = new Map<unknown, LiteralSecretRedactor>();
	const combined = new LiteralSecretRedactor(secrets);
	return {
		env,
		push(source: unknown, chunk: Buffer): Buffer {
			let redactor = streams.get(source);
			if (!redactor) streams.set(source, redactor = new LiteralSecretRedactor(secrets));
			return combined.push(redactor.push(chunk));
		},
		flush(): Buffer {
			const output = [...streams.values()].map(redactor => combined.push(redactor.flush()));
			output.push(combined.flush());
			return Buffer.concat(output);
		},
	};
}
export function credentialOperations(operations: BashOperations, sessionID: string | undefined): BashOperations {
	return { ...operations, exec: async (command, cwd, options) => {
		const child = credentialChildState(sessionID, options.env ?? process.env);
		try { return await operations.exec(command, cwd, { ...options, env: child.env,
			onData: function(this: unknown, chunk: Buffer) {
				const safe = child.push(this instanceof Readable ? this : undefined, chunk);
				if (safe.length) options.onData(safe);
			},
		}); } finally { const remaining = child.flush(); if (remaining.length) options.onData(remaining); }
	} };
}
export function clearCredentialBinding(binding: CredentialBinding): void {
	if (!isCredentialBindingCurrent(binding)) return;
	const state = runtime.sessions.get(binding.localSessionID)!;
	for (const grant of state.grants.values()) clearTimeout(grant.timer);
	state.grants.clear(); runtime.sessions.delete(binding.localSessionID);
}
export function clearCredentialGrants(): void {
	for (const state of runtime.sessions.values()) clearCredentialBinding(state.binding);
}
