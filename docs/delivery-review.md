# Independent delivery review (HIV-3802)

Subagent's delivery checkpoint defaults on for substantive code changes. Before
`git push` or `gh pr create`, run a foreground `code-reviewer` review and resolve
its findings. The prompt provides the complete merge-base diff, file inventory
and scope paths, not the author's rationale or conclusions.

Stage new files first. Successful foreground reviews stamp the reviewed diff;
later edits, staging or commits invalidate it. Review the final commit before
pushing. Committed, staged and unstaged evidence is kept separate so a dirty
revert cannot hide delivered code. Review
results with errors and background launch receipts never satisfy the checkpoint.
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
Revision-changing prefixes, alternate PR heads/bases, dynamic checkouts, Git
configuration overrides and
over-budget delivery commands require an explicit override. Review is scoped to
current HEAD to origin: alternate destinations, other explicit source refs,
matching/all/tag/mirror pushes, configured refspecs and pipelines (whose `cd` may
be subprocess-local) cannot be stamped as a HEAD review. Runtime schema-retry and
continuation feedback survives neutralization; only the author's original
request loses its rationale. Requested non-Git paths remain in the neutral
review scope, with delivery scope explicitly unverified.
