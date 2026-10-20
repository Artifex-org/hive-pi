/** Evidence-dependent hints (HIV-3802). No builds, network, or unbounded reads. */
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { splitCommands } from "../guards-common/shell-split.ts";
import { BASE_REF_SCAN, fetchedOriginBase, knownBaseRef } from "../guards-common/git-base.ts";

export const SCAN_BYTES = 256 * 1024;
export type GitRead = (args: string[], cwd: string, timeoutMs?: number) => Promise<string>;
export const gitRead: GitRead = (args, cwd, timeoutMs = 1500) => new Promise((accept, reject) => {
	execFile("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: SCAN_BYTES }, (error, out) => error ? reject(error) : accept(out));
});

/** Read only a bounded regular file, never a pipe/socket or a final-component symlink. */
export async function boundedFile(path: string): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > SCAN_BYTES) throw new Error("not a regular file within the 256 KiB scan budget");
		const buf = Buffer.alloc(SCAN_BYTES + 1);
		const { bytesRead } = await file.read(buf, 0, buf.length, 0);
		if (bytesRead > SCAN_BYTES) throw new Error("file grew beyond the scan budget");
		return buf.subarray(0, bytesRead).toString("utf8");
	} finally { await file.close(); }
}

/** The words of one simple command, and why they are not all literal (if they are not). */
export interface ShellWords {
	words: string[];
	/** The first construct whose value only exists at run time, named for a reader; null when every word is literal. */
	dynamic: string | null;
	/** Why the text is not a complete command at all (an unbalanced quote); null when it is. */
	malformed: string | null;
}

const EXPANDS = /[\w{(?!@#$*\-]/;

function expansionName(text: string, at: number): string {
	const next = text[at + 1];
	if (next === "(") return "a command substitution `$(…)`";
	if (next === "{") return "a parameter expansion `${…}`";
	const name = /^\w+/.exec(text.slice(at + 1))?.[0];
	return name ? `a variable \`$${name}\`` : `a special parameter \`$${next}\``;
}

/**
 * Split ONE simple command into words under POSIX quoting: single quotes are
 * literal, double quotes honour `\$ \` \" \\`, and a backslash outside quotes
 * escapes the next character — so `'it'\''s'` is the one word `it's`.
 * Substitutions and expansions (`$(…)`, backticks, `$VAR`, `${…}`, `$'…'`)
 * outside single quotes make the command dynamic; their raw text is kept in
 * the word.
 */
export function shellWords(segment: string): ShellWords {
	const words: string[] = [];
	let word = "";
	let started = false;
	let dynamic: string | null = null;
	let malformed: string | null = null;
	const note = (what: string) => { dynamic ??= what; };
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (/\s/.test(ch)) {
			if (started) words.push(word);
			word = "";
			started = false;
			continue;
		}
		started = true;
		if (ch === "'") {
			const close = segment.indexOf("'", i + 1);
			if (close < 0) { malformed = "an unbalanced single quote"; word += segment.slice(i + 1); break; }
			word += segment.slice(i + 1, close);
			i = close;
			continue;
		}
		if (ch === '"') {
			let j = i + 1;
			for (; j < segment.length && segment[j] !== '"'; j++) {
				const c = segment[j];
				if (c === "\\" && /[$`"\\\n]/.test(segment[j + 1] ?? "")) {
					if (segment[j + 1] !== "\n") word += segment[j + 1];
					j++;
					continue;
				}
				if (c === "`") note("a backtick command substitution");
				else if (c === "$" && EXPANDS.test(segment[j + 1] ?? "")) note(expansionName(segment, j));
				word += c;
			}
			if (j >= segment.length) { malformed = "an unbalanced double quote"; break; }
			i = j;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 < segment.length && segment[i + 1] !== "\n") word += segment[i + 1];
			i++;
			continue;
		}
		if (ch === "`") note("a backtick command substitution");
		else if (ch === "$" && (segment[i + 1] === "'" || segment[i + 1] === '"')) note("ANSI-C or locale quoting `$'…'`");
		else if (ch === "$" && EXPANDS.test(segment[i + 1] ?? "")) note(expansionName(segment, i));
		word += ch;
	}
	if (started && !malformed) words.push(word);
	return { words, dynamic, malformed };
}

/** What makes this segment's words not literal (a substitution, a variable, an unbalanced quote), or null. */
export function literalProblem(segment: string): string | null {
	const parsed = shellWords(segment);
	return parsed.malformed ?? parsed.dynamic;
}

/** Literal shell words only. Dynamic shell expressions are not guessed. */
export function literalWords(segment: string, allowDynamicValues = false): string[] | null {
	const parsed = shellWords(segment);
	if (parsed.malformed || (parsed.dynamic && !allowDynamicValues)) return null;
	return parsed.words;
}

export function goRunPatterns(command: string): string[] {
	const patterns: string[] = [];
	for (const segment of splitCommands(command.slice(0, 8192), true)) {
		const words = literalWords(segment);
		if (!words) continue;
		while (/^\w+=/.test(words[0] ?? "")) words.shift();
		if (words[0] !== "go" || words[1] !== "test") continue;
		for (let i = 2; i < words.length; i++) {
			if (words[i] === "-args") break;
			if (words[i] === "-run" && words[i + 1] !== undefined) patterns.push(words[++i]);
			else if (words[i].startsWith("-run=")) patterns.push(words[i].slice(5));
		}
	}
	return patterns;
}

// `go test` flags that take a separate value, so the value is not read as a package.
const GO_TEST_VALUE_FLAGS = new Set(["-run", "-skip", "-count", "-timeout", "-tags", "-p", "-parallel", "-bench", "-benchtime", "-cpu",
	"-coverprofile", "-coverpkg", "-covermode", "-o", "-exec", "-vet", "-list", "-shuffle", "-fuzz", "-fuzztime", "-fuzzminimizetime",
	"-memprofile", "-memprofilerate", "-cpuprofile", "-blockprofile", "-blockprofilerate", "-mutexprofile", "-mutexprofilefraction",
	"-outputdir", "-trace", "-modfile", "-mod", "-C", "-ldflags", "-gcflags", "-asmflags", "-pkgdir", "-toolexec"]);

/**
 * The test files one `go test` invocation compiles, as git pathspecs relative to its directory:
 * a relative package is its own directory, `/...` adds the subtree, no package means `.`.
 * Null for import paths (their directory is unknown here): the caller scans every test file.
 */
export function goTestPathspecs(segment: string): string[] | null {
	const words = literalWords(segment);
	if (!words) return null;
	while (/^\w+=/.test(words[0] ?? "")) words.shift();
	if (words[0] !== "go" || words[1] !== "test") return null;
	const packages: string[] = [];
	for (let i = 2; i < words.length; i++) {
		const word = words[i];
		if (word === "-args") break;
		if (word.startsWith("-")) { if (!word.includes("=") && GO_TEST_VALUE_FLAGS.has(word)) i++; continue; }
		packages.push(word);
	}
	const specs: string[] = [];
	for (const pkg of packages.length ? packages : ["."]) {
		if (!/^\.{1,2}(\/|$)/.test(pkg)) return null;
		const recursive = pkg === "./..." || pkg.endsWith("/...");
		const dir = (recursive ? pkg.slice(0, -4) : pkg).replace(/\/+$/, "") || ".";
		specs.push(recursive ? `:(glob)${dir}/**/*_test.go` : `:(glob)${dir}/*_test.go`);
	}
	return specs;
}

export function addedGoTests(diff: string): string[] {
	return [...new Set([...diff.matchAll(/^\+func (Test[\p{L}\p{Nd}_]*)\s*\(\s*\w+\s+\*testing\.T\s*\)/gmu)].map((m) => m[1]).filter((name) => !/^Test\p{Ll}/u.test(name)))];
}

/** The safe JS/RE2 intersection; unsupported Go syntax is explicitly NOT checked. */
export function excludedGoTests(pattern: string, names: readonly string[]): string[] | null {
	// -run separates parent/subtest regexps on unbracketed slashes. A parent
	// match runs its body, so only the first component decides added func Tests.
	if (pattern.includes("/")) return null;
	if (names.some((name) => name.length > 128) || pattern.length > 256 || /\(\?|\\[1-9pPzACQ]|\)[*+?{]|\{|\[:/.test(pattern) || (pattern.match(/[*+]/g)?.length ?? 0) > 1) return null;
	try {
		const regex = new RegExp(pattern);
		return names.filter((name) => !regex.test(name));
	} catch { return null; }
}

export async function goTestHint(command: string, cwd: string, git: GitRead = gitRead, read = boundedFile): Promise<string | null> {
	if (goRunPatterns(command).length === 0) return null;
	const start = Date.now();
	const messages: string[] = [];
	const scanGit = (args: string[], dir: string) => {
		const remaining = 2000 - (Date.now() - start);
		if (remaining <= 0) throw new Error("total scan budget exhausted");
		return git(args, dir, Math.min(1500, remaining));
	};
	try {
		let dir = cwd;
		let invocations = 0;
		for (const segment of splitCommands(command, true)) {
			const words = literalWords(segment);
			if (/^\s*cd\s/.test(segment)) {
				if (words?.length !== 2) throw new Error("dynamic or unsupported checkout");
				dir = resolve(dir, words[1]); continue;
			}
			const patterns = goRunPatterns(segment);
			if (patterns.length === 0) continue;
			if (++invocations > 2 || Date.now() - start > 2000) throw new Error("total scan budget exhausted");
			let declared = "";
			try { declared = await scanGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], dir); }
			catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
			let head = knownBaseRef(declared, declared.trim() ? "" : await scanGit(BASE_REF_SCAN, dir));
			if (!head) {
				const path = (await scanGit(["rev-parse", "--git-path", "FETCH_HEAD"], dir)).trim();
				const origin = (await scanGit(["config", "--get", "remote.origin.url"], dir)).trim();
				head = fetchedOriginBase(resolve(dir, path), origin);
			}
			if (!head) throw new Error("no declared or conventional base ref");
			const base = (await scanGit(["merge-base", "HEAD", head], dir)).trim();
			// Only the packages this invocation tests: an added test elsewhere is not one it excludes.
			const scope = goTestPathspecs(segment) ?? ["*_test.go"];
			const diff = await scanGit(["diff", "--no-color", "--no-ext-diff", "--unified=0", base, "--", ...scope], dir);
			const untracked = (await scanGit(["ls-files", "--others", "--exclude-standard", "--", ...scope], dir)).trim().split("\n").filter(Boolean);
			if (untracked.length > 8) throw new Error("more than eight untracked test files");
			let additions = diff;
			for (const path of untracked) {
				if (Date.now() - start > 2000) throw new Error("total scan budget exhausted");
				additions += "\n" + (await read(resolve(dir, path))).split("\n").map((l) => "+" + l).join("\n");
				if (Buffer.byteLength(additions) > SCAN_BYTES) throw new Error("256 KiB aggregate scan budget exhausted");
			}
			const names = addedGoTests(additions);
			if (names.length > 100 || names.some((n) => n.length > 128)) throw new Error("added test name budget exhausted");
			if (names.length === 0) continue;
			// Last flag wins WITHIN this invocation, never across shell commands.
			const pattern = patterns.at(-1)!;
			const excluded = excludedGoTests(pattern, names);
			if (excluded === null) messages.push("Added Go tests found, but this -run pattern is outside the bounded matcher; coverage NOT checked. Run the added tests without -run before delivery.");
			else if (excluded.length > 0) messages.push(`In ${dir}, -run ${JSON.stringify(pattern)} excludes tests added in the tested packages: ${excluded.join(", ")}. Run them too, e.g. -run '^(${excluded.join("|")})$' on the same packages, before delivery; a green selected run does not cover this change.`);
		}
	} catch (error) {
		messages.push(`Added-test coverage NOT checked: merge-base/diff scan failed or exceeded its bounded budget (${String(error).slice(0, 160)}). Check added func Test names against -run before delivery.`);
	}
	return messages.length ? "\n\n[harness hint · go-test-run] " + messages.join("\n") : null;
}

export async function socketTimeoutHint(text: string, cwd: string, sandboxed: boolean, read = boundedFile): Promise<string | null> {
	if (!sandboxed || !/Test timed out\b/.test(text)) return null;
	const sections = [...text.slice(0, SCAN_BYTES).matchAll(/\bFAIL\s+([^\s]+\.(?:test|spec)\.[cm]?[jt]sx?)\b([^]*?)(?=\n\s*FAIL\s|\n\s*Test Files\b|$)/g)];
	const paths = [...new Set(sections.filter((m) => /Test timed out\b/.test(m[2])).map((m) => m[1]))].slice(0, 4);
	for (const path of paths) {
		const full = resolve(cwd, path);
		const rel = relative(cwd, full);
		if (isAbsolute(rel) || rel.startsWith("..")) continue;
		try {
			const source = await read(full);
			if (!/[/'"`]([^\s'"`]*\.sock)\b/.test(source)) continue;
			return `\n\n[harness hint · unix-socket-timeout] ${path} timed out and contains a unix-socket path. In this sandbox AF_UNIX may be refused without the test surfacing EPERM. Check readiness's unix sockets row; run these tests on the repo's CI/fleet, not by weakening their timeout or assertions. This is evidence of an environment constraint, not proof of the cause.`;
		} catch (error) {
			return `\n\n[harness hint · unix-socket-timeout] Socket-source scan NOT checked for ${path}: ${String(error).slice(0, 160)}. Check readiness before diagnosing a sandboxed test timeout.`;
		}
	}
	return null;
}

export interface ObservedRead { path: string; text: string }
export async function codemodeTruncationHint(text: string, fullOutputPath: unknown, reads: readonly ObservedRead[], read = boundedFile): Promise<string | null> {
	// This marker is produced by upstream extensions/codemode/execute.ts's
	// truncateOutput, not the TUI's collapsed preview or a nested read's cap.
	if (!/^Warning: truncated output \(original token count: \d+\)/m.test(text) ||
		(typeof fullOutputPath !== "string" && !/\[Could not save the full output:/.test(text))) return null;
	let attribution = "Read attribution unavailable (no observed nested reads).";
	if (reads.length > 0) {
		try {
			if (typeof fullOutputPath !== "string") throw new Error("full output was not saved");
			const full = await read(fullOutputPath);
			const cut = reads.filter((r) => r.text && full.includes(r.text) && !text.includes(r.text));
			attribution = cut.length > 0 ? `Reads cut: ${cut.map((r) => r.path).join(", ")}.` : "No whole read could be attributed to the cut (the script may have transformed/filtered the reads).";
		} catch (error) {
			attribution = `Read attribution NOT checked (${String(error).slice(0, 120)}); reads in this batch: ${reads.map((r) => r.path).join(", ")}.`;
		}
	}
	return `\n\n[harness hint · codemode-truncated] ${attribution} Do not treat this inspection as complete. Use one bounded read per call (offset/limit), or filter/aggregate before printing; the codemode output budget cuts the combined output, not each file separately.`;
}
