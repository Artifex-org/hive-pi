/**
 * Where agmsg lives, and whether it lives here at all.
 *
 * agmsg is a SKILL INSTALL, not an npm dependency: `~/.agents/skills/agmsg`
 * with a `scripts/` directory of bash entry points. Nothing in this extension
 * imports agmsg code — every call goes through those scripts, which own the
 * SQLite schema, the actas locks and the roster. That is deliberate: the DB
 * layout is agmsg's private business and has already changed shape across
 * releases, while the script contracts have not.
 *
 * The whole extension is inert when the install is absent, so a hive-pi user
 * without agmsg pays nothing: no handlers, no tools, no commands.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Scripts this extension calls. Named so a typo is a type error, not a runtime ENOENT. */
export type AgmsgScript =
	| "whoami.sh"
	| "watch.sh"
	| "check-inbox.sh"
	| "inbox.sh"
	| "send.sh"
	| "team.sh"
	| "history.sh"
	| "join.sh"
	| "delivery.sh"
	| "actas-claim.sh";

/**
 * The install root. `$AGMSG_HOME` wins so a test (or a second checkout) can
 * point at a scratch install without touching the real message DB — the same
 * seam agmsg's own suite uses via `AGMSG_STORAGE_PATH`.
 */
export function agmsgHome(): string {
	const override = process.env.AGMSG_HOME?.trim();
	if (override) return override;
	return join(homedir(), ".agents", "skills", "agmsg");
}

export function scriptPath(script: AgmsgScript, home = agmsgHome()): string {
	return join(home, "scripts", script);
}

/**
 * True when this machine has agmsg installed.
 *
 * Probes `whoami.sh` rather than the directory: an uninstall that leaves an
 * empty `~/.agents/skills/agmsg` behind (the shape `uninstall.sh` leaves when
 * `db/` is preserved) must read as "not installed", or every session pays for
 * tools whose first call fails.
 */
export function agmsgInstalled(home = agmsgHome()): boolean {
	return existsSync(scriptPath("whoami.sh", home));
}
