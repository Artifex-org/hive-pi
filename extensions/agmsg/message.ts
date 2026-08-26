/**
 * The watcher's stdout, parsed.
 *
 * `watch.sh` emits exactly one line per delivered message:
 *
 *     printf '%s | %s | %s → %s | %s\n' "$ts" "$team" "$from" "$to" "$body"
 *
 * and interleaves human-readable notices on the same stream ("no available
 * identities", "cannot claim (held by other sessions)"). Both matter and they
 * are NOT interchangeable: a message is injected into the conversation and
 * wakes the agent; a notice is shown to the human and must never be. Telling
 * them apart is this module's whole job, and it is a pure fold so it can be
 * tested without a DB, a watcher, or a session.
 *
 * BODY NEWLINES ARE ESCAPED BY THE PRODUCER. watch.sh runs the body through
 * SQL `replace(body, char(10), '\n')`, so a multi-line message arrives as one
 * line containing a literal backslash-n. Unescaping is therefore part of
 * parsing, not cosmetics — without it a pasted stack trace reaches the model as
 * one unreadable line.
 */

/** A delivered agmsg message. */
export interface AgmsgMessage {
	kind: "message";
	/** ISO-ish timestamp as agmsg stored it. Passed through, never reformatted. */
	ts: string;
	team: string;
	from: string;
	/** The identity this session is receiving as — a watcher may hold several. */
	to: string;
	body: string;
}

/** Anything the watcher said that is not a message. */
export interface AgmsgNotice {
	kind: "notice";
	text: string;
}

export type WatchLine = AgmsgMessage | AgmsgNotice;

/**
 * The producer's format, reversed.
 *
 * The first four fields are non-greedy so a body containing " | " stays whole
 * in the body — the alternative (a greedy split on " | ") silently reassigns
 * the tail of a message that merely mentions a pipe. `[\s\S]*` for the body
 * rather than `.*` because an unescaped newline in the body would otherwise
 * end the match early and turn the message into a notice.
 */
const MESSAGE_RE = /^(.+?) \| (.+?) \| (.+?) → (.+?) \| ([\s\S]*)$/;

export function parseWatchLine(line: string): WatchLine | null {
	const trimmed = line.replace(/\r$/, "");
	if (!trimmed.trim()) return null;

	const match = MESSAGE_RE.exec(trimmed);
	if (!match) return { kind: "notice", text: trimmed.trim() };

	const [, ts, team, from, to, body] = match;
	return { kind: "message", ts, team, from, to, body: unescapeBody(body) };
}

/** Undo watch.sh's `char(10) → '\n'` escaping. A literal `\\n` stays literal. */
export function unescapeBody(body: string): string {
	return body.replace(/\\(\\|n)/g, (_all, ch: string) => (ch === "n" ? "\n" : "\\"));
}

/**
 * What the model sees.
 *
 * Two things are load-bearing beyond the text itself:
 *
 *  - The reply address is spelled out as a tool call. A message that says only
 *    "alice asks: …" reliably produces an answer addressed to the HUMAN, which
 *    nobody receives. Naming `agmsg_send` with the arguments already filled in
 *    is what makes the reply land back in the team.
 *  - The recipient identity (`to`) is included, because one watcher can hold
 *    several roles at once (a leader subscribed to every project role). Without
 *    it the model cannot tell which of its identities was addressed, and replies
 *    as the wrong one.
 */
export function formatInjection(msg: AgmsgMessage): string {
	return [
		`[agmsg] ${msg.from} → ${msg.to} (team ${msg.team}, ${msg.ts})`,
		"",
		msg.body,
		"",
		`Reply with agmsg_send(team: "${msg.team}", to: "${msg.from}", message: "…") — as ${msg.to}.`,
	].join("\n");
}

/**
 * Notices worth showing the human.
 *
 * The watcher's normal chatter includes one line that fires on every session in
 * a project nobody has joined ("no available identities … nothing to do"). It
 * is correct, it is also the single most common line the watcher ever prints,
 * and surfacing it as a notification would train the user to ignore the
 * channel. Everything else — a claim conflict, an unreadable DB, an argument
 * error — is a real problem and gets through.
 */
export function isSilentNotice(text: string): boolean {
	return /nothing to do$/.test(text.trim());
}
