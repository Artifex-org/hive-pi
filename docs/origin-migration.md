# Origin migration readiness

This change prepares hive-pi for Hive Origin; it does not move the live repository.
The public GitHub source, Actions checks and workstation default pin remain in
place until an operator completes and verifies cutover.

The native gate in `.hive/main.star` preserves Node 24, ignored dependency install
scripts, the pinned real browser, typechecking/tests, and both full-history and
working-tree secret scans. A shallow history must be expanded or the gate fails.
It declares container execution, no organization secrets, no service account,
no private overlay and no deployment lane. Before admitting public code, verify
the actual worker isolation, checkout-only credentials, callback permissions and
network boundary. This file is not permission to run external fork submissions
on privileged workers. Native merge policy must be derived from the trusted
default branch; missing infrastructure is a failed readiness gate, not a skip.

Workspace grants now carry provider, stable project/repository identity and exact
clone URL. Native sources never become a GitHub URL. Public native clones are
anonymous; private cross-project clones require a separate explicit human
read-credential approval. Ordinary workspace consent or an automatic verdict
does not widen a launch token's project scope. The per-repository helper is
read-only and bound to that request; it stores no token in Git configuration.
Native reads refuse redirects, inherited Git rewrites/headers and a mismatched
existing remote. Before handing off a new or reused checkout, provisioning also
checks the ordinary inherited configuration for rewrites and HTTP settings that
affect the approved URL. This is a handoff-time check, not a promise that later
user edits to Git configuration remain safe. Credential repair reinstalls the
scoped helper after the generic reset, so old section order cannot disable it.
Isolated clone and updater transports carry only the approved URL’s effective
`http.sslCAInfo`, `http.sslCAPath`, and `http.version` settings from inherited
configuration. Headers, helpers, and URL rewrites are not carried across.
Existing files and unpushed work are not reset.

A source identity conflict needs fresh consent: call `request_workspace` with
a new explicit `request_id`, and reuse that ID while its approval is pending.
Do not automatically repeat consent or repoint an old grant after a provider
cutover. An already-delivered grant is not proof that a checkout succeeded.

The standalone updater reads versioned, non-secret `update-sources.json`
written by the provisioner after source verification. Native updates require
that file, an unchanged canonical remote and an unpinned source. They reject
inherited URL rewrites/HTTP headers, reset unrelated Git credentials, name the
verified URL and branch explicitly, and use a fresh read-only helper for the
private overlay. The provisioner records each unpinned base or overlay's local branch and selected
`origin` tracking branch, which may have different names. Tenant bases need not
use `main`. Missing branch metadata requires reprovisioning; switching local
branches prevents updates, and an arbitrary upstream cannot redirect a pull. Public updates
do not use Hive credentials. Source changes require approved reprovisioning,
not a timer silently retargeting a checkout. Keep a pinned source on Hive's
pin-verifying refresh lane instead of advancing it through this timer.

After cutover, Origin is the development and PR authority; GitHub is a public,
bot-written read-only mirror. Verify mirror ref equality and direct new
contributions to Origin. Updating the installer default or archiving a private
overlay source is a separate operator checkpoint, not performed by this PR.
