import type { WorkspaceRepoGrant } from "./client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY_UUID = "00000000-0000-0000-0000-000000000000";
const SEGMENT = "[a-z0-9][a-z0-9_-]{0,62}";
const ORIGIN_PATH = new RegExp(`^/origin/${SEGMENT}/${SEGMENT}\\.git$`);

export interface WorkspaceCloneSource {
	url: string;
	native: boolean;
	helper?: string;
}

function uuid(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value) && value !== EMPTY_UUID;
}

/** Shell data for Git's !helper command, never executable caller text. */
function shellQuote(value: string): string {
	return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** A native grant is a complete, server-bound identity, never a GitHub slug. */
export function nativeWorkspaceSource(grant: WorkspaceRepoGrant): WorkspaceCloneSource {
	if (grant.source_provider !== "hive" || !uuid(grant.project_id) || !uuid(grant.repository_id) ||
		typeof grant.project !== "string" || !grant.project.trim() || grant.project.length > 200 ||
		/[\u0000-\u001f\u007f]/.test(grant.project)) {
		throw new Error("Native workspace identity is incomplete; request fresh consent from an updated Hive server.");
	}
	let url: URL;
	try { url = new URL(grant.clone_url ?? ""); } catch { throw new Error("Native workspace has no canonical clone URL."); }
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
		!ORIGIN_PATH.test(url.pathname) || url.href !== grant.clone_url) {
		throw new Error("Native workspace clone URL is not a canonical credential-free HTTPS Origin URL.");
	}
	if (grant.public_read === true) return { url: url.href, native: true };
	if (grant.public_read !== false || !uuid(grant.workspace_grant_id)) {
		throw new Error("Private native workspace requires explicit read approval and a bound workspace grant.");
	}
	const helper = "!hive git-credential --workspace-grant " + shellQuote(grant.workspace_grant_id) +
		" --project " + shellQuote(grant.project) + " --read-only";
	return { url: url.href, native: true, helper };
}

/** No inherited helper, URL rewrite, object alternate or HTTP header may escape
 * the approved clone identity. The helper reads auth itself: no secret in argv. */
export function nativeWorkspaceGitEnv(apiURL: string, environment: NodeJS.ProcessEnv = process.env, credentialed = true): string[] {
	const api = new URL(apiURL);
	if (api.username || api.password || api.search || api.hash || !["http:", "https:"].includes(api.protocol)) {
		throw new Error("Hive credential helper API URL is invalid.");
	}
	const base = apiURL.replace(/\/api\/v1\/?$/, "").replace(/\/$/, "");
	if (credentialed && environment.HIVE_TOKEN && environment.HIVE_URL?.replace(/\/api\/v1\/?$/, "").replace(/\/$/, "") !== base) {
		throw new Error("Inherited Hive credentials are not bound to this API URL; use matching managed session credentials.");
	}
	return [
		"-u", "GIT_CONFIG_PARAMETERS", "-u", "GIT_CONFIG_SYSTEM",
		"-u", "GIT_DIR", "-u", "GIT_WORK_TREE", "-u", "GIT_COMMON_DIR",
		"-u", "GIT_INDEX_FILE", "-u", "GIT_OBJECT_DIRECTORY", "-u", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "-u", "GIT_TEMPLATE_DIR",
		...(!credentialed ? ["-u", "HIVE_TOKEN"] : []),
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_COUNT=0",
		"GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "SSH_ASKPASS=", "HIVE_URL=" + base,
	];
}

export function nativeWorkspaceGitConfig(source: WorkspaceCloneSource): Array<[string, string]> {
	const values: Array<[string, string]> = [
		["credential.helper", ""], ["credential.useHttpPath", "true"],
		["http.followRedirects", "false"], ["http.extraHeader", ""],
	];
	if (source.helper) values.push(["credential." + source.url + ".helper", source.helper]);
	return values;
}
