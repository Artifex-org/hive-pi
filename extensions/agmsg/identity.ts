/**
 * Who this session is on the message bus.
 *
 * `whoami.sh <project> pi` answers in id(1) style — one line of `key=value`
 * pairs — and has four distinct answers, not one:
 *
 *     agent=misaki teams=aggie type=pi project=/home/dev/repos/x
 *     multiple=true agents=a,b teams=t1,t2 type=pi project=…
 *     suggest=true agents=a,b teams=… type=pi project=… available_teams=…
 *     not_joined=true available_teams=t1,t2
 *
 * The distinction is the point. "Not joined" is the normal state of most
 * projects and must stay silent and free; "multiple" needs a human to choose;
 * only the single-identity case may start a watcher on its own. Collapsing them
 * into `Identity | null` is what makes an extension either nag every session or
 * silently receive as the wrong role.
 *
 * PARSING IS SEPARATE FROM EXECUTION so the four shapes are testable without an
 * install, a DB or a roster.
 */

import { execFileSync } from "node:child_process";

import { agmsgHome, scriptPath } from "./paths.ts";

const WHOAMI_TIMEOUT_MS = 5_000;

export interface JoinedIdentity {
	state: "joined";
	agent: string;
	teams: string[];
	type: string;
	/** agmsg's own resolved project root — NOT cwd. Delivery config hangs off this. */
	project: string;
}

export interface AmbiguousIdentity {
	state: "multiple" | "suggest";
	agents: string[];
	teams: string[];
	type: string;
	project: string;
	availableTeams: string[];
}

export interface NotJoined {
	state: "not-joined";
	availableTeams: string[];
}

export type Identity = JoinedIdentity | AmbiguousIdentity | NotJoined;

/**
 * Split a `key=value key=value` line.
 *
 * A naive `split(" ")` breaks on `project=/path with spaces`, which is a real
 * path shape on macOS. Each value therefore runs to the next `key=` token or to
 * end of line, which is exactly how the producer builds it.
 */
export function parseKeyValues(line: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /([a-z_]+)=(.*?)(?=\s+[a-z_]+=|\s*$)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(line)) !== null) out[match[1]] = match[2].trim();
	return out;
}

function list(value: string | undefined): string[] {
	if (!value || value === "none") return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function parseWhoami(stdout: string): Identity {
	// whoami.sh prints one identity line; anything before it (a registry warning
	// about an untrusted plugin, for instance) goes to stderr, but read the LAST
	// non-empty line anyway so a stray stdout notice cannot shift the parse.
	const line = stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.pop();
	const kv = parseKeyValues(line ?? "");

	if (kv.not_joined === "true" || (!kv.agent && !kv.agents)) {
		return { state: "not-joined", availableTeams: list(kv.available_teams) };
	}

	if (kv.multiple === "true" || kv.suggest === "true") {
		return {
			state: kv.multiple === "true" ? "multiple" : "suggest",
			agents: list(kv.agents),
			teams: list(kv.teams),
			type: kv.type ?? "pi",
			project: kv.project ?? "",
			availableTeams: list(kv.available_teams),
		};
	}

	return {
		state: "joined",
		agent: kv.agent ?? "",
		teams: list(kv.teams),
		type: kv.type ?? "pi",
		project: kv.project ?? "",
	};
}

/**
 * Ask agmsg who we are.
 *
 * BLOCKING (a bash script over SQLite, single-digit ms in practice, bounded at
 * 5s). pi awaits event handlers serially, so a handler that called this would
 * BE the agent loop for its duration — every caller here resolves from a
 * detached timer or a command handler instead. See index.ts.
 *
 * A failure is "not joined with no teams offered": the extension then does
 * nothing, which is the correct behaviour for a machine without agmsg, a
 * corrupt install, or a project the user never joined.
 */
export function resolveIdentity(project: string, home = agmsgHome()): Identity {
	try {
		const stdout = execFileSync(scriptPath("whoami.sh", home), [project, "pi"], {
			timeout: WHOAMI_TIMEOUT_MS,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return parseWhoami(stdout);
	} catch {
		return { state: "not-joined", availableTeams: [] };
	}
}

/** One-line identity for the footer and `/agmsg`. */
export function describeIdentity(identity: Identity): string {
	switch (identity.state) {
		case "joined":
			return `${identity.agent} @ ${identity.teams.join(", ") || "no team"}`;
		case "multiple":
			return `ambiguous: ${identity.agents.join(", ")}`;
		case "suggest":
			return `not joined here (known elsewhere as ${identity.agents.join(", ")})`;
		case "not-joined":
			return identity.availableTeams.length
				? `not joined (teams: ${identity.availableTeams.join(", ")})`
				: "not joined";
	}
}
