/**
 * The shared shell segmenter and literal-word reader the guards build on:
 * redirect `&`, here-documents, and POSIX quote escapes.
 */
import { describe, expect, it } from "vitest";
import { splitCommandList, splitCommands, stripBenignRedirects } from "../extensions/guards-common/shell-split.ts";
import { literalProblem, literalWords } from "../extensions/toolhints/contextual.ts";

describe("splitCommands", () => {
	it("does not split the & of a redirect", () => {
		expect(splitCommands("git push --no-verify -u origin HEAD 2>&1")).toEqual(["git push --no-verify -u origin HEAD 2>&1"]);
		expect(splitCommands("cmd >&2 && next")).toEqual(["cmd >&2 ", " next"]);
		expect(splitCommands("cmd <&0; cmd &>out.log; cmd >|forced")).toEqual(["cmd <&0", " cmd &>out.log", " cmd >|forced"]);
	});

	it("still splits a background job and reports it as a pipeline", () => {
		let pipeline = false;
		expect(splitCommands("sleep 1 & git push", false, () => { pipeline = true; })).toEqual(["sleep 1 ", " git push"]);
		expect(pipeline).toBe(true);
	});

	it("records the separator after each segment", () => {
		expect(splitCommandList("a && b | c; d", true).map((s) => s.separator)).toEqual(["&&", "|", ";", ""]);
	});

	it("respects backslash escapes outside and inside double quotes", () => {
		expect(splitCommands("echo a\\;b && echo \"x \\\" ; y\"")).toEqual(["echo a\\;b ", " echo \"x \\\" ; y\""]);
	});

	it("keeps a quoted here-document body out of the segments", () => {
		const command = "gh pr create --body-file - <<'EOF'\nIt's done && git push other HEAD\n$(not run)\nEOF\ngit status";
		expect(splitCommands(command, true)).toEqual(["gh pr create --body-file - <<'EOF'", "git status"]);
	});

	it("splits a here-document fed to a shell or piped on as commands", () => {
		expect(splitCommands("bash <<'EOF'\ngit push origin HEAD\nEOF", true)).toContain("git push origin HEAD");
		expect(splitCommands("cat <<'EOF' | sh\ngit -c user.name=x commit -m m\nEOF", true)).toContain("git -c user.name=x commit -m m");
		expect(splitCommands("ssh host <<EOF\ngit push\nEOF", true)).toContain("git push");
	});

	it("does not read a here-string as a here-document", () => {
		expect(splitCommands('grep foo <<< "$x"\ngit push --force origin main', true)).toEqual(['grep foo <<< "$x"', "git push --force origin main"]);
		expect(stripBenignRedirects('grep foo <<< "$x"').other).toBe(true);
	});

	it("does not read an arithmetic shift as a here-document", () => {
		expect(splitCommands("(( y = x << n ))\ngit push origin HEAD\nn\necho hi", true)).toEqual(["(( y = x << n ))", "git push origin HEAD", "n", "echo hi"]);
	});

	it("keeps an expanding here-document body attached to its command", () => {
		const [first, second] = splitCommands("cat <<EOF\n$(git reset --hard)\nEOF\ngit status", true);
		expect(first).toContain("$(git reset --hard)");
		expect(second).toBe("git status");
		expect(splitCommands("cat <<-EOF\n\tplain text\n\tEOF\necho done", true)).toEqual(["cat <<-EOF", "echo done"]);
	});
});

describe("stripBenignRedirects", () => {
	it.each([
		["git push origin HEAD 2>&1", "git push origin HEAD"],
		["git push >/dev/null 2>/dev/null", "git push"],
		["git push &>/dev/null", "git push"],
		["gh pr create --body-file - <<'EOF'", "gh pr create --body-file -"],
		["cmd 1>&2 <&0 >&-", "cmd"],
	])("removes fd duplication, /dev/null and here-doc operators: %s", (segment, text) => {
		const result = stripBenignRedirects(segment);
		expect(result.other).toBe(false);
		expect(result.text.trim().replace(/\s+/g, " ")).toBe(text);
	});

	it.each(["git push > log", "git push 2>>err", "cmd < input.txt", "cmd <<< here", "diff <(a) <(b)", "cmd >(tee x)"])("flags a file or process redirect: %s", (segment) => {
		expect(stripBenignRedirects(segment).other).toBe(true);
	});

	it("leaves quoted angle brackets alone", () => {
		expect(stripBenignRedirects("gh pr create --title 'a > b' --body \"x < y\"")).toEqual({ text: "gh pr create --title 'a > b' --body \"x < y\"", other: false });
	});
});

describe("literalWords", () => {
	it("reads POSIX quote escapes as literal", () => {
		expect(literalWords("gh pr create --draft --body 'a '\\''b'\\'' c'")).toEqual(["gh", "pr", "create", "--draft", "--body", "a 'b' c"]);
		expect(literalWords("echo don\\'t \\$HOME \"say \\\"hi\\\" \\$x\" a\\ b")).toEqual(["echo", "don't", "$HOME", 'say "hi" $x', "a b"]);
		expect(literalWords("echo 'cost $5 `x`'")).toEqual(["echo", "cost $5 `x`"]);
	});

	it.each([
		['gh pr create --body "$(cat x)"', "a command substitution `$(…)`"],
		["echo `date`", "a backtick command substitution"],
		['echo "`date`"', "a backtick command substitution"],
		["echo $VAR", "a variable `$VAR`"],
		['echo "${VAR}"', "a parameter expansion `${…}`"],
		["echo $'a\\nb'", "ANSI-C or locale quoting"],
		["echo 'unbalanced", "an unbalanced single quote"],
		['echo "unbalanced', "an unbalanced double quote"],
	])("rejects %s and names why", (segment, problem) => {
		expect(literalWords(segment)).toBeNull();
		expect(literalProblem(segment)).toContain(problem);
	});

	it("keeps dynamic values when asked to", () => {
		expect(literalWords('gh pr create --body "$(cat x)"', true)).toEqual(["gh", "pr", "create", "--body", "$(cat x)"]);
		expect(literalWords("echo 'open", true)).toBeNull();
	});
});
