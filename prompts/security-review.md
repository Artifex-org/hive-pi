Run a security review of this repository's pending changes: $ARGUMENTS

Structure (modeled on the Claude Code security Action and piolium's verify
chamber; scaled to a daily-driver pass — piolium stays the on-demand deep
audit):

## 1. Scope

Default: the diff against the merge base (`git diff origin/<default>...HEAD`
plus uncommitted changes) and files reachable FROM those changes. If the
arguments say `full` (or name a path), scope is that instead. List the scoped
files with line counts before proceeding.

## 2. Threat model (one `research` subagent)

Delegate a read-only recon: what does this code trust, what crosses a
privilege or network boundary, which entry points does the diff touch, what
secrets/config are in play. Ask for a compact map, not prose.

## 3. Parallel finders (subagent tool, parallel mode, role `security-finder`)

One task per class, each carrying the scope file list and its class:
1. injection (SQL/command/template/path)
2. authz & authn (missing checks, IDOR, privilege boundaries)
3. secrets & config (credentials in code, weak defaults, exposed endpoints)
4. supply chain (dependency pins, install scripts, fetched code)
5. logic & concurrency (state machines, TOCTOU, races, trust of client state)

Finders are read-only with no shell — do not hand them bash even if it seems
convenient; the code under review is untrusted input to them.

## 4. Adversarial verification (role `security-verifier`, one per finding)

For every finding with confidence ≥ 0.5, spawn a verifier that receives ONLY
`file / line / claim / exploit_scenario` — never the finder's rationale, never
sibling findings. Drop findings the verifier REFUTES; keep its verdict line
attached to survivors. UNVERIFIABLE survives only at severity HIGH.

## 5. False-positive filter

Discard (even if confirmed): DoS/rate-limiting/resource-exhaustion, secrets
on the developer's own disk, generic input validation without a proven impact
path, open redirects. A repo may override this list in
`.pi/security-review.md` — read it if present and apply its additions or
removals. Then drop everything below confidence 0.7.

## 6. Report

A table sorted HIGH→LOW: `severity · confidence · file:line · class · claim`,
each followed by its exploit scenario, the verifier's reason, and the
one-line recommendation. Then a coverage statement (what was scoped, what
finders could not reach). State plainly when the result is "no findings
survived verification" — that is a real result, not a failure.

Do NOT auto-fix anything. If the arguments include `--file-tickets`, first
search Linear for existing tickets covering each finding, then create tickets
only for the unmatched ones (team from the repo's project mapping), and list
created/matched keys in the report.
