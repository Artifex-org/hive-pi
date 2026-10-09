import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";

/** Prefer origin/HEAD, otherwise an existing conventional REMOTE base.
 * A local main/master branch is not evidence of the delivery baseline. */
export const BASE_REFS = ["refs/remotes/origin/main", "refs/remotes/origin/master"];
export const BASE_REF_SCAN = ["for-each-ref", "--format=%(refname)", ...BASE_REFS];
export function knownBaseRef(head: string | null, refs: string): string | null {
	if (head?.trim()) return head.trim();
	const present = new Set(refs.trim().split("\n"));
	return BASE_REFS.find((ref) => present.has(ref)) ?? null;
}

/** Bare clones can map fetches straight to local refs. Git's FETCH_HEAD records
 * are remote evidence; a bare local branch name alone is not. Never accept a
 * different repository's record or a different branch as the base. */
export function fetchedBaseRef(records: string, origin: string): string | null {
	const normalize = (url: string) => url.trim().replace(/^([\w+.-]+:\/\/)[^/@]+@/, "$1").replace(/^[^/@:]+@(?=[^/:]+:)/, "").replace(/\.git\/?$/, "").replace(/\/$/, "");
	if (!origin.trim()) return null;
	for (const branch of ["main", "master"]) {
		for (const line of records.split("\n")) {
			const m = line.match(/^([a-f0-9]{40}|[a-f0-9]{64})\t(?:not-for-merge)?\tbranch '([^']+)' of (.+)$/);
			if (m?.[2] === branch && normalize(m[3]) === normalize(origin)) return m[1];
		}
	}
	return null;
}

/** Bounded, lock-free metadata read, not a tracked file supplied by the author. */
export function fetchedOriginBase(path: string, origin: string): string | null {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
	catch { return null; }
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 256 * 1024) return null;
		const buffer = Buffer.alloc(stat.size + 1);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		if (length !== stat.size) return null;
		return fetchedBaseRef(buffer.subarray(0, length).toString("utf8"), origin);
	} catch { return null; }
	finally { closeSync(fd); }
}
