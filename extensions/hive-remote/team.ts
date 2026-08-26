/**
 * hive-remote/team — parsing and rendering for the `team_message` command.
 *
 * Hive's agents workspace groups sessions into teams (orchestrator → workers),
 * and the server relays teammate traffic to this client as a claimed command
 * whose payload is the JSON parsed here. Pure by design — no pi imports — so
 * the wire contract can be tested without a running agent, exactly like
 * transcript.ts.
 *
 * HIV-1488 adds two categories on top of the original three:
 *
 *   - `digest` — the periodic team-state push. Carries an OPTIONAL structured
 *     `digest` payload beside the server-rendered `text`. The server sends
 *     both, so a client older than this build reads `text` and loses only the
 *     formatting; that is what lets the server ship the feature before every
 *     workstation has updated.
 *   - `note`  — one shared-memory note the server judged worth pushing ahead of
 *     the next digest (a handoff, an open question).
 *
 * Neither wakes an idle agent — see triggersTurn.
 */

export type TeamMessageCategory = "relationship" | "message" | "lifecycle" | "digest" | "note";

/** One roster line in a digest: who they are and what they are on. Every field
 *  past `id` is optional because the server assembles them from sources that
 *  are each independently allowed to be absent (no PR yet, no plan, a session
 *  that never reported activity). */
export type TeamDigestMember = {
	id: string;
	title: string;
	/** active | done | abandoned | … — the server's `live_state`, passed through
	 *  rather than enumerated, on the same argument `origin` is not enumerated. */
	liveState?: string;
	branch?: string;
	/** Pre-composed by the server, e.g. `#3128 open · ci ✓`. Composing it here
	 *  would mean this file owning CI vocabulary it has no other reason to know. */
	pr?: string;
	/** e.g. `execute 3/7`. */
	plan?: string;
	activity?: string;
	/** True for the recipient's own row, so the digest can mark it. */
	self?: boolean;
};

/** A shared-memory note, as it appears in a digest. The BODY is deliberately
 *  absent: a digest is an index, and an agent that wants the body calls
 *  `read_team_notes`. Otherwise one chatty teammate's essay lands in every
 *  member's context on every sweep. */
export type TeamDigestNote = {
	kind: string;
	subject: string;
	author?: string;
	at?: string;
};

export type TeamDigest = {
	teamName?: string;
	members?: TeamDigestMember[];
	notes?: TeamDigestNote[];
	/** Human-readable collision lines ("X and Y are both on feat/z"). */
	conflicts?: string[];
};

export type TeamMessage = {
	category: TeamMessageCategory;
	text: string;
	fromSessionID?: string;
	fromTitle?: string;
	selfSessionID?: string;
	teammates?: { id: string; title: string }[];
	digest?: TeamDigest;
};

/** Bounds on a parsed digest. `details` here is server-authored rather than
 *  model-authored, so these are a runaway guard and not a security boundary —
 *  but an unbounded roster still lands in a context window, so it is bounded
 *  on ARRIVAL like every other payload this client accepts. */
const MAX_DIGEST_MEMBERS = 40;
const MAX_DIGEST_NOTES = 20;
const MAX_DIGEST_CONFLICTS = 10;

/** Categories this build renders natively. Anything else degrades — see below. */
const KNOWN_CATEGORIES: TeamMessageCategory[] = ["message", "relationship", "digest", "note"];

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * parseDigest reads the structured half of a digest payload.
 *
 * Every field is optional and every malformed entry is dropped rather than
 * failing the message: the digest is an enrichment of `text`, which the server
 * always sends, so a partially-unreadable digest must still deliver its prose.
 * Returns undefined when there is nothing usable, which the renderer treats as
 * "fall back to text".
 */
function parseDigest(raw: unknown): TeamDigest | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const digest: TeamDigest = {};

	const teamName = optionalString(obj.team_name);
	if (teamName) digest.teamName = teamName;

	if (Array.isArray(obj.members)) {
		const members = obj.members.flatMap((entry): TeamDigestMember[] => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
			const m = entry as Record<string, unknown>;
			const id = optionalString(m.id);
			if (!id) return [];
			const member: TeamDigestMember = { id, title: typeof m.title === "string" ? m.title : "" };
			const liveState = optionalString(m.live_state);
			if (liveState) member.liveState = liveState;
			const branch = optionalString(m.branch);
			if (branch) member.branch = branch;
			const pr = optionalString(m.pr);
			if (pr) member.pr = pr;
			const plan = optionalString(m.plan);
			if (plan) member.plan = plan;
			const activity = optionalString(m.activity);
			if (activity) member.activity = activity;
			if (m.self === true) member.self = true;
			return [member];
		});
		if (members.length > 0) digest.members = members.slice(0, MAX_DIGEST_MEMBERS);
	}

	if (Array.isArray(obj.notes)) {
		const notes = obj.notes.flatMap((entry): TeamDigestNote[] => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
			const n = entry as Record<string, unknown>;
			const subject = optionalString(n.subject);
			if (!subject) return [];
			const note: TeamDigestNote = { kind: typeof n.kind === "string" ? n.kind : "note", subject };
			const author = optionalString(n.author);
			if (author) note.author = author;
			const at = optionalString(n.at);
			if (at) note.at = at;
			return [note];
		});
		if (notes.length > 0) digest.notes = notes.slice(0, MAX_DIGEST_NOTES);
	}

	if (Array.isArray(obj.conflicts)) {
		const conflicts = obj.conflicts.filter((c): c is string => typeof c === "string" && c !== "");
		if (conflicts.length > 0) digest.conflicts = conflicts.slice(0, MAX_DIGEST_CONFLICTS);
	}

	return digest.teamName || digest.members || digest.notes || digest.conflicts ? digest : undefined;
}

/**
 * parseTeamMessage reads the server's payload defensively.
 *
 * `text` is the one required field — a message with nothing to say is garbage,
 * and garbage returns null so the caller can fold an honest "could not read"
 * notice instead of injecting an empty message into the turn.
 *
 * An unknown or missing category degrades to "lifecycle" rather than null:
 * lifecycle semantics are purely informational, so a newer server introducing
 * a category this build has never heard of still gets its text delivered
 * instead of breaking an older client.
 *
 * Optional fields are copied only when they are strings / well-shaped, so a
 * malformed extra never leaks into the rendered message.
 */
export function parseTeamMessage(payload: string): TeamMessage | null {
	let raw: unknown;
	try {
		raw = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.text !== "string" || obj.text === "") return null;

	const category = KNOWN_CATEGORIES.find((c) => c === obj.category) ?? "lifecycle";
	const msg: TeamMessage = { category, text: obj.text };

	if (typeof obj.from_session_id === "string" && obj.from_session_id) msg.fromSessionID = obj.from_session_id;
	if (typeof obj.from_title === "string" && obj.from_title) msg.fromTitle = obj.from_title;
	if (typeof obj.self_session_id === "string" && obj.self_session_id) msg.selfSessionID = obj.self_session_id;
	if (Array.isArray(obj.teammates)) {
		const teammates = obj.teammates.flatMap((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
			const { id, title } = entry as Record<string, unknown>;
			if (typeof id !== "string" || !id || typeof title !== "string") return [];
			return [{ id, title }];
		});
		if (teammates.length > 0) msg.teammates = teammates;
	}
	// Parsed for every category, not just `digest`: the payload is the server's
	// to shape, and dropping a field because the category did not predict it is
	// how a forward-compatible wire contract stops being one.
	const digest = parseDigest(obj.digest);
	if (digest) msg.digest = digest;
	return msg;
}

/** One roster line: `• Worker 2 (you) — active · branch feat/x · #12 open, ci ✓ · plan execute 3/7`. */
function renderMember(m: TeamDigestMember): string {
	const name = m.title || m.id;
	const facts = [m.liveState, m.branch ? `branch ${m.branch}` : "", m.pr, m.plan ? `plan ${m.plan}` : "", m.activity]
		.filter((f): f is string => Boolean(f))
		.join(" · ");
	const head = `• ${name}${m.self ? " (you)" : ""}`;
	return facts ? `${head} — ${facts}` : head;
}

/**
 * renderDigest turns the structured payload into the block the agent reads.
 *
 * Conflicts come FIRST and notes second: a digest is read at the top of a turn
 * and the one thing in it that should change what the agent does next is
 * "someone else is on your branch". Burying that under a roster is how it gets
 * skimmed past.
 */
function renderDigest(d: TeamDigest, text: string): string {
	const lines: string[] = [d.teamName ? `Team digest — ${d.teamName}` : "Team digest"];
	if (text) lines.push(text);
	if (d.conflicts?.length) {
		lines.push("Conflicts:");
		for (const c of d.conflicts) lines.push(`  ! ${c}`);
	}
	if (d.members?.length) {
		lines.push(`Members (${d.members.length}):`);
		for (const m of d.members) lines.push(`  ${renderMember(m)}`);
	}
	if (d.notes?.length) {
		lines.push("New shared notes (read_team_notes for the bodies):");
		for (const n of d.notes) {
			const who = n.author ? ` ${n.author}:` : "";
			lines.push(`  - [${n.kind}]${who} ${n.subject}`);
		}
	}
	return lines.join("\n");
}

/**
 * renderTeamMessage builds the text the agent actually reads.
 *
 * The self session id line is what lets the agent identify itself to the hive
 * MCP tools when replying to a teammate; the teammates line tells it who else
 * exists to talk to. Both are appended rather than interleaved so the message
 * body stays first and readable.
 */
export function renderTeamMessage(msg: TeamMessage): string {
	let out: string;
	if (msg.category === "message") {
		if (msg.fromTitle && msg.fromSessionID) {
			out = `Team message from "${msg.fromTitle}" (${msg.fromSessionID}): ${msg.text}`;
		} else if (msg.fromTitle) {
			out = `Team message from "${msg.fromTitle}": ${msg.text}`;
		} else if (msg.fromSessionID) {
			out = `Team message from ${msg.fromSessionID}: ${msg.text}`;
		} else {
			out = `Team message: ${msg.text}`;
		}
	} else if (msg.category === "digest" && msg.digest) {
		out = renderDigest(msg.digest, msg.text);
	} else if (msg.category === "note") {
		// A pushed note names its author the way a direct message does — the
		// author is the actionable part of "someone claimed the store layer".
		out = msg.fromTitle ? `Team note from "${msg.fromTitle}": ${msg.text}` : `Team note: ${msg.text}`;
	} else {
		// Includes `digest` with no structured payload: the server always sends
		// prose, so a digest this build cannot enrich still reads as an update.
		out = `Team update: ${msg.text}`;
	}
	if (msg.selfSessionID) out += `\n(Your Hive session id: ${msg.selfSessionID})`;
	if (msg.teammates && msg.teammates.length > 0) {
		out += `\nTeammates: ${msg.teammates.map((t) => `${t.title} (${t.id})`).join(", ")}`;
	}
	return out;
}

/**
 * triggersTurn decides whether a team message wakes an idle agent.
 *
 * Only a direct teammate message does — it is addressed to this agent and
 * usually wants an answer. Everything else is context, not conversation: it
 * rides as followUp and is seen at the next turn, so a chatty team cannot burn
 * tokens spinning an idle worker.
 *
 * This is what makes the periodic digest affordable at all. A digest goes to
 * EVERY member on a timer; if it woke them, an idle team would bill a full turn
 * per member per sweep forever, which is precisely the cost `activity.ts`'s
 * `shouldReport()` refuses to pay for a session that has nothing to say.
 */
export function triggersTurn(category: TeamMessage["category"]): boolean {
	return category === "message";
}
