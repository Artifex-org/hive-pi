# Security

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on
this repository (Security → Report a vulnerability), which reaches the
maintainers without disclosing the problem first.

Please include what an attacker gains, not only what the code does — a
reproduction, however rough, is worth more than a description.

## What this code is, and what that means for its threat model

This is a harness for a coding agent. It runs on a developer's machine with that
developer's privileges, and several extensions deliberately do things that would
be alarming in a web application: execute commands, read files, fetch URLs
chosen by a model, and hold credentials for services the agent talks to.

Two consequences worth stating plainly:

- **The model is not trusted, but it is powerful.** Anything reachable by a URL
  the model picks — or by a redirect from a page it fetched — is inside the
  attack surface. `extensions/web/ssrf.ts` exists for exactly this and is the
  file to look at hardest. A bypass there is a real finding, not a theoretical
  one.
- **The guards are productivity guards, not sandboxes.** The worktree guard and
  the capability declarations in `extensions/guards-common/` prevent mistakes.
  They are not an adversarial boundary and do not claim to be; a worker spawned
  with `--no-extensions` does not carry them. Real isolation is the sandbox the
  agent runs *in*, not this code. Please report bypasses anyway — we would
  rather know — but calibrate severity accordingly.

## What is out of scope

- Anything requiring an already-compromised Hive control plane, unless the
  client could reasonably have defended itself (we do validate server-issued
  paths and repo slugs, for instance, and a gap in that validation *is* in
  scope).
- The absence of a guarantee this project does not make. Credentials on the
  operator's own disk, under the operator's own account, are the operator's.

## Credentials

No credential is ever committed here, and none is written into a checkout.
`gitleaks` runs over the full history on every push and pull request.
