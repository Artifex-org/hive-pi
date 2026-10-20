# Independent delivery review (HIV-3802)

Subagent's delivery checkpoint defaults on for substantive code changes. Before
`git push` or `gh pr create`, run a foreground `code-reviewer` review and resolve
its findings. The prompt provides the complete merge-base diff, file inventory
and scope paths, not the author's rationale or conclusions.

Stage new files first. A successful review stamps the reviewed diff, keyed by
its evidence fingerprint and by the content it covers: committing exactly the
reviewed tree keeps the stamp, while a later edit, staging change or amend
invalidates it. A commit hook that rewrites the reviewed code is caught after a
chained commit: the delivery result says so and the next push or PR needs a new
review. Committed, staged and unstaged evidence is kept separate so a dirty
revert cannot hide delivered code. Review results with errors never satisfy the
checkpoint.

A background `code-reviewer` counts once it finishes cleanly and three
fingerprints agree: this side's capture at dispatch, the worker's own evidence
fingerprint (carried on the job's finish event), and this side's capture at
completion. A launch receipt alone, a worker that stopped mid-work, and a worker
that could not capture the diff it reviewed never count.

When no reviewer model can run in the session, the checkpoint records "review
unavailable" for that exact diff and lets delivery of it proceed, with a visible
note on the delivery result; state it in the PR description.
The worker returns the fingerprint of the complete evidence supplied inline or
in a readable patch artifact; the checkpoint compares it to current evidence
before recording a stamp, never to a separate pre-launch snapshot. Patches over
256KiB use a private, mode-0600 temporary artifact and a bounded inline preview.
Patches with oversized raw lines (for example, minified JSON) are encoded as a
lossless JSON array of string chunks with bounded rows. Concatenating the decoded
entries reconstructs the exact raw patch; fingerprints still cover that raw
patch, not its transport encoding.
The reviewer must read every artifact page before concluding. The harness checks
that successful read results cover the artifact's exact captured bytes, including
pages limited by the read tool's line/byte cap. Unread or partially read artifacts
receive no stamp, even if the worker reports success. A reviewer that cannot
complete the review emits a plain, unquoted final-response line beginning with
`DELIVERY_REVIEW_INCOMPLETE` (optionally followed by a colon and reason). This
explicit refusal also prevents stamping inline patches, including declarations
in later text blocks. Inline quotations and fenced or indented code examples
with surrounding review prose are not declarations. A response consisting only
of fenced or indented code containing a marker line is ambiguous and fails
closed as incomplete; a genuine refusal must use the plain-line contract. The
artifact exists throughout worker execution and is removed afterward, including
on failure. Its temporary path is not part of the fingerprint.

Oversized `code-reviewer` reviews can continue in the **same private persisted
conversation**, retaining the artifact and observed read coverage. The runner
plans contiguous pages under both read limits (40KiB and 1,000 lines), assigns
eight pages per invocation, and budgets at most
`min(64, max(4, ceil(pageCount / 8) + 1))` continuations. This workload-sized allowance includes an integration conclusion;
it is not an unbounded retry. Each continuation requires newly observed coverage;
once all pages are read, at most one invocation may finish the integration review
and cumulative conclusion. No progress or budget exhaustion fails closed with
explicit covered/unread ranges. Failed reviews expose their full cumulative
partial report to the parent, never a review stamp.
The runner verifies the exact session ID, checkout and last persisted assistant
report before resuming: a missing transcript is a refusal, not a fresh review.
Every continuation and final result rechecks the original evidence fingerprint.
Failures, aborts, changed evidence and a final incomplete declaration never
stamp. Every retained-review report supplies one unquoted, unfenced protocol line:
`REVIEW_LEDGER {"complete":false,"findings":[...]}`. The mandatory boolean is
`true` only when the full semantic review is complete; observed reads alone never
set it. A ledger-only final report is valid only with explicit `complete:true`,
full coverage and every required disposition. New records have `id:null`, `status:"new"` and
nonempty `location` (`path:line`), `issue`, `scenario`, and `evidence` fields containing
the full supporting details. The parent assigns distinct stable IDs even for bugs
at the same location. Each later report must reconcile **every** previous ID using
`id:"F1"`, `status:"upheld"|"resolved"|"withdrawn"`, `location` and `evidence`.
The original issue, reproduction scenario and evidence are immutable; dispositions
cannot erase them. These canonical records are re-injected as untrusted data after
compaction. Human recaps are presentation, never finding identity, so rephrasing
cannot invent a finding ID. The structured fields must contain all supporting
details, not references to prose that may be compacted away.

Malformed frames and unknown/duplicate IDs fail immediately; their full raw
reports remain in failure diagnostics, never silently repaired into approval.
Missing dispositions, explicit `complete:false`, bare ID mentions and quoted/code
examples cannot complete a review. Canonical finding state and
retained continuation prompt data are capped at 64KiB; overflow fails explicitly,
never truncates support. This is not a cap on the private transcript or full
failure diagnostics. Single, chain, parallel, background completion and expanded terminal views share
cumulative review-output handling. On failure/cancellation all distinct reports
are returned, even
if a later worker died after emitting progress text (including text beside tool
calls). Successful results also return the canonical original evidence alongside
the final dispositions. Human-conclusion checks exclude protocol bytes and run
before canonical evidence is appended, so metadata cannot disguise unfinished work.
Parallel output caps preserve complete text in private temporary files (0600 in
0700 directories); previews return retrieval paths, including through text-only
MCP adapters. Follow those references before relying on truncated output. These
files outlive the tool call for at least 24 hours; expired, unchanged, owned
artifacts are pruned on the next spill. Changed/foreign directories are not
removed. This is temporary retrieval storage, not a long-term archive.
The final report must cover the entire change, not only newly read pages. Coverage is necessary, not
approval. Session files and artifacts are deleted on all exits; ordinary workers
remain ephemeral (`--no-session`).
The command's `cd` / `git -C` checkout is checked, not the launch's checkout.
Newline-separated commands count too; quoted body text does not.

Docs-only changes and one tracked file with at most five changed lines are
exempt. Lock-free Git capture is bounded to 16MiB and a 2s total deadline, separate
from the 256KiB inline prompt limit. All three layer inventories are collected
before patch reads, so a patch failure retains complete scope and is explicitly
marked incomplete. Missing base refs, over-budget diffs, untracked content and
binary changes are never
stamped as reviewed. An explicit override is available after reviewing such a
change: set `PI_DELIVERY_REVIEW=0` for the session or prefix the delivery command
with it. The checkpoint says when it cannot verify; it never silently blesses
incomplete scope.

Base discovery uses Git's origin/HEAD declaration, or an existing conventional
remote main/master ref for clones without that declaration. Local branch names
are not evidence of a delivery baseline. No known remote base means no complete
delivery diff. For bare clones lacking remote refs, Git's FETCH_HEAD is evidence
only when it records origin's exact URL and a fetched main/master branch.
The checkpoint supports literal git/gh delivery forms, not
arbitrary shell programs; only literal `cd` prefixes may precede delivery.
`hive ship --draft` is target-preserving and uses the same matching-review check
as `hive ship` and `hive ship --no-pr`; destination-changing flags remain refused.
Revision-changing prefixes, unpaired/unsupported PR target overrides, dynamic checkouts, Git
configuration overrides and
over-budget delivery commands require an explicit override. Review is scoped to
current HEAD to origin: alternate destinations, other explicit source refs,
matching/all/tag/mirror pushes, configured refspecs and pipelines (whose `cd` may
be subprocess-local) cannot be stamped as a HEAD review. Runtime schema-retry and
continuation feedback survives neutralization; only the author's original
request loses its rationale. Requested non-Git paths remain in the neutral
review scope, with delivery scope explicitly unverified.

## Explicit release PR targets (HIV-3997)

For a same-repository promotion such as `main → prod`, review the release,
not the feature diff that may already have merged. Fetch both origin branches
separately, finish local mutations, and use a clean checkout whose committed
tree equals the remote source tree (an identical-tree merged feature is fine).
Index flags that hide edits (assume-unchanged/skip-worktree) and active source
filters are refused, including inside initialized submodules. Global unused
filter-driver configuration (such as LFS) is harmless. Submodules must be
recursively initialized at their recorded commits; submodule-ignore settings
cannot conceal dirty or stale dependency sources:

```js
subagent({
  agent: "code-reviewer",
  task: "Review the release",
  cwd: "/path/to/repo",
  reviewTarget: { base: "prod", head: "main" }
})
```

This is single foreground mode only. The harness resolves both **live origin
branch SHAs**, requires their commit objects locally, and supplies the complete
merge-base-to-source patch. Evidence binds the repository, origin URL identity
(without exposing URL credentials), branch names and both exact SHAs. Ordinary
feature reviews cannot satisfy this target; even a docs-only release needs a
matching target review. Both endpoints are revalidated on completion,
continuation and delivery, so moving either branch — even an empty commit with
identical patch bytes — requires a fresh review. A persisted stamp remains
usable only while that same evidence matches.

After resolving findings, retry a standalone literal command:

```sh
gh pr create --base prod --head main --title "release" --body-file /tmp/release.md
```

Paired `-B`/`-H` and `--base=…`/`--head=…` are also supported. Fork heads,
repository overrides, unpaired targets, interactive web/recovery forms, ambiguous
remote configuration and unknown explicit-target options fail closed. The
supported checkout has exactly one remote, `origin`; its explicitly pinned gh
default is honored, otherwise `gh repo view` must resolve to that same repository
(including fork/upstream cases). Custom push URLs, URL rewrites, alternate gh defaults and
`GH_REPO`/`GH_HOST` overrides are refused. Incomplete captures and binary placeholders do not stamp. Explicit target
capture inspects actual endpoint blobs independently of Git attributes, so
text-forcing rules cannot disguise binary assets. It supports gzip-compressed
UTF-8 data by including lossless encoded bytes and ALL decoded text from each
changed endpoint in the same
coverage-checked artifact. Base64 is losslessly wrapped at 76 columns so it does
not force otherwise readable patch and decoded data into JSON chunks.
Reading encoded bytes alone cannot stamp the review;
the decoded sections must also be read. Unknown binary formats, invalid UTF-8,
NUL-containing decoded content, individual endpoint blobs over 16MiB, and
patch-plus-decoded evidence over 16MiB fail
closed. Every existing endpoint of a binary-classified path must currently be
gzip text; plaintext-to-gzip or gzip-to-plaintext replacements are deliberately
unsupported rather than silently reviewed with incomplete evidence. Reviewers still report semantically unreviewable assets as incomplete.
Partial clones are refused and lazy fetching is disabled. No automatic fetch,
branch write or production action occurs during capture.

**This is a review checkpoint, not release approval or a merge gate.** Obtain
the required operator approval separately, and inspect the eventual PR merge
tree, CI and rollout; branches can move after the final preflight check.
Running sessions must pick up the updated extension through the normal harness
updater and interactive `/reload` before this parameter is available.
