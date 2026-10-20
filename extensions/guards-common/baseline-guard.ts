/**
 * Gate-baseline guard: WARN when a change loosens a gate's recorded baseline.
 *
 * A baseline file is the gate's memory of tolerated debt (a codemetrics
 * complexity baseline) or of the bar it holds (a coverage floor). In the
 * HIV-3906 eval an agent hit a pre-existing codemetrics failure on trunk and
 * raised the function's entry in `scripts/metrics/codemetrics-baseline.txt` in
 * an unrelated change, which made the gate pass by tolerating more debt
 * instead of reporting the failure it found.
 *
 * Warn-only, by design: changing a baseline is sometimes the task itself (a
 * ratchet, a deliberate re-baseline), and a refusal there would cost a real
 * change. The note lands on the tool result that made the change, at the
 * moment the agent can still revert it.
 *
 * Direction matters: a debt baseline or ceiling is looser when a value rises
 * or a new entry appears; a floor (coverage minimum) is looser when a value
 * falls or an entry is removed.
 */

import { basename, isAbsolute, resolve } from "node:path";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { literalWords } from "../toolhints/contextual.ts";
import { splitCommands } from "./shell-split.ts";

const SOURCE = /\.(?:go|ts|tsx|js|jsx|mjs|cjs|py|rs|java|kt|rb|sh|star|c|h|cc|cpp|cs|swift|md|rst|html|css)$/i;
const MAX_BYTES = 1024 * 1024;
const NUMBER = /-?\d+(?:\.\d+)?/g;

/** A data file a gate compares against: a baseline, floor, threshold or ratchet, never source code or prose. */
export function isGateBaseline(path: string): boolean {
	const name = basename(path);
	return /baseline|floor|threshold|ratchet/i.test(name) && !SOURCE.test(name);
}

/** Higher is stricter for a floor (coverage minimums); lower is stricter for everything else. */
function isFloor(path: string): boolean {
	return /floor|minimum|coverage/i.test(basename(path));
}

function entries(text: string): Map<string, { line: string; values: number[] }> {
	const map = new Map<string, { line: string; values: number[] }>();
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || /^(?:#|\/\/|;)/.test(line)) continue;
		const values = (line.match(NUMBER) ?? []).map(Number);
		if (values.length === 0) continue;
		const key = line.replace(NUMBER, "#");
		if (!map.has(key)) map.set(key, { line, values });
	}
	return map;
}

/** The entries `after` loosens relative to `before`, described for a reader (at most five). */
export function loosenedEntries(path: string, before: string, after: string): string[] {
	const floor = isFloor(path);
	const old = entries(before);
	const now = entries(after);
	const found: string[] = [];
	for (const [key, entry] of now) {
		const prior = old.get(key);
		if (!prior) {
			if (!floor) found.push(`new entry \`${entry.line}\``);
			continue;
		}
		const looser = entry.values.some((value, i) => prior.values[i] !== undefined && (floor ? value < prior.values[i] : value > prior.values[i]));
		if (looser) found.push(`\`${entry.line}\` (was \`${prior.line}\`)`);
	}
	if (floor) for (const [key, entry] of old) if (!now.has(key)) found.push(`removed \`${entry.line}\``);
	return found.slice(0, 5);
}

/** Bounded read of a regular file; null when it is absent, special or too large. */
export function readBaseline(path: string): string | null {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
	catch { return null; }
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_BYTES) return null;
		const buffer = Buffer.alloc(stat.size);
		return buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0)).toString("utf8");
	} catch { return null; }
	finally { closeSync(fd); }
}

/** Tracked baseline files of the repository holding `cwd`, absolute. */
export function trackedBaselines(cwd: string): string[] {
	try {
		const root = execFileSync("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		const files = execFileSync("git", ["--no-optional-locks", "ls-files", "-z"], { cwd: root, encoding: "utf8", timeout: 2000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
		return files.split("\0").filter((file) => file && isGateBaseline(file)).slice(0, 20).map((file) => resolve(root, file));
	} catch { return []; }
}

/**
 * The baseline files a tool call may change, to snapshot before it runs.
 * An edit or write names its file. A shell command is only considered when it
 * mentions a baseline at all (a path, or an updater flag like
 * `-update-baseline`), and then the repository's tracked baselines are taken
 * along with any path it names.
 */
export function baselineCandidates(toolName: string, input: Record<string, unknown>, cwd: string, tracked = trackedBaselines): string[] {
	if (toolName === "edit" || toolName === "write") {
		const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
		return path && isGateBaseline(path) ? [isAbsolute(path) ? path : resolve(cwd, path)] : [];
	}
	const command = typeof input.command === "string" ? input.command : "";
	if (!/baseline|floor|threshold|ratchet/i.test(command)) return [];
	const named = splitCommands(command, true).flatMap((segment) => literalWords(segment, true) ?? [])
		.map((word) => word.replace(/^[<>]+/, "")).filter((word) => word && isGateBaseline(word) && /[./]/.test(word)).map((word) => resolve(cwd, word));
	return [...new Set([...named, ...tracked(cwd)])];
}

/** File contents before the tool call, by absolute path (null for absent). */
export type BaselineSnapshot = Map<string, string | null>;

export function snapshotBaselines(paths: readonly string[], readFile = readBaseline): BaselineSnapshot {
	return new Map(paths.map((path) => [path, readFile(path)]));
}

/** The warning for a snapshot whose files the tool call loosened, or null. */
export function baselineNote(snapshot: BaselineSnapshot, readFile = readBaseline): string | null {
	const changes: string[] = [];
	for (const [path, before] of snapshot) {
		const after = readFile(path);
		if (after === null || after === before) continue;
		const loosened = loosenedEntries(path, before ?? "", after);
		if (loosened.length > 0) changes.push(`${path}: ${loosened.join("; ")}`);
	}
	if (changes.length === 0) return null;
	return `This loosened a gate baseline — ${changes.join(" | ")}. Loosening a gate in an unrelated change hides a pre-existing failure: revert it and report the failure (with its evidence) instead, unless changing this gate is the task itself.`;
}
