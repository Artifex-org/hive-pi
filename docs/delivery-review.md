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
The command's `cd` / `git -C` checkout is checked, not the launch's checkout.
Newline-separated commands count too; quoted body text does not.

Docs-only changes and one tracked file with at most five changed lines are
exempt. Lock-free Git capture is bounded to 256KiB and a 2s total deadline. Missing
base refs, over-budget diffs, untracked content and binary changes are never
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
arbitrary shell programs; dynamic checkouts, git configuration overrides and
over-budget delivery commands require an explicit override. Review is scoped to
current HEAD to origin: alternate destinations, other explicit source refs,
matching/all/tag/mirror pushes, configured refspecs and pipelines (whose `cd` may
be subprocess-local) cannot be stamped as a HEAD review. Runtime schema-retry and
continuation feedback survives neutralization; only the author's original
request loses its rationale. Requested non-Git paths remain in the neutral
review scope, with delivery scope explicitly unverified.
