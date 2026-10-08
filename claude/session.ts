/**
 * The server's agent-session id for this launch.
 *
 * `HIVE_SESSION_ID` is the session's CLIENT RUN ID (what the MCP
 * `X-Hive-Session` header carries), not the server uuid the REST paths take.
 * It is resolved once through `GET /api/v1/agent-sessions/by-run/{run id}` —
 * hive-remote's own `resolveSession`, the route the Claude driver uses too —
 * and cached in the state dir. An unresolved id is NOT cached: the session is
 * not attached yet, and the next settle asks again.
 */

import { join } from "node:path";
import { resolveSession } from "../extensions/hive-remote/client.ts";
import type { HiveAuth } from "../extensions/hive-common/http.ts";
import { readJson, writeJsonAtomic } from "./state.ts";

export type SessionResolution = { ok: true; id: string } | { ok: false; reason: string };

export async function serverSessionId(auth: HiveAuth | null, runId: string | undefined, stateDir: string): Promise<SessionResolution> {
	if (!auth) return { ok: false, reason: "no Hive auth in this launch (HIVE_URL/HIVE_TOKEN unset)" };
	if (!runId) return { ok: false, reason: "HIVE_SESSION_ID is unset" };
	const path = join(stateDir, "session.json");
	const cached = readJson(path) as { runId?: unknown; id?: unknown } | undefined;
	if (cached && cached.runId === runId && typeof cached.id === "string" && cached.id) return { ok: true, id: cached.id };
	const id = await resolveSession(auth, runId);
	if (!id) return { ok: false, reason: `the session (run ${runId}) does not resolve on Hive yet — not attached, or the lookup failed` };
	writeJsonAtomic(path, { runId, id });
	return { ok: true, id };
}
