# workstation — the machine skeleton

What a machine needs that is not part of the pi *package*. pi reads its
configuration only from `~/.pi/agent/`, so these files are **stowed or linked**,
never installed with `pi install`.

This directory is the PUBLIC skeleton. It carries no credentials, no hostnames,
and no organisation's configuration — only the defaults and the tooling any
machine running this harness wants.

| Path | What | Delivery |
|---|---|---|
| `.pi/agent/settings.default.json` | the default `settings.json` for a machine with no private overlay | read and materialised by `hive-agent workstation harness install` |
| `.pi/agent/scripts/` | measurement and drift-check helpers pi's own config references | linked to `~/.pi/agent/scripts` |
| `.local/bin/hive-pi-update` | the self-updater: fast-forward this checkout, upgrade the pinned pi | stow → `~/.local/bin` |
| `.config/systemd/user/hive-pi-update.{service,timer}` | runs the updater on a timer | stow → `~/.config/systemd/user` |
| `bin/` | optional local dev services (Postgres for `devservices`, a kernel venv) | run by hand, once |

## What is deliberately NOT here

**`mcp.json`, `AGENTS.md`, org agent roles, and the real `settings.json`.** Those
are an organisation's own configuration: which servers it runs, which repos it
has, how its agents are told to behave. They live in a private *overlay*
repository, and a machine that has one gets the overlay's files symlinked into
`~/.pi/agent/` in place of the defaults above.

**`auth.json`.** A model credential is leased per session from Hive and must
never be provisioned into a checkout on disk.

**`house-profile.json`.** The organisation's projects, knowledge collections and
product MCP servers — see `extensions/profile-common/profile.ts`. Absent is a
supported state: every consumer degrades to a conservative default.

## Materialising `~/.pi/agent`

`hive-agent workstation harness install` does this. By hand:

```sh
stow -d <this checkout>/workstation -t ~ .          # scripts, updater, timer
# then EITHER the defaults:
sed "s#{{HIVE_PI_ROOT}}#<this checkout>#g" \
  workstation/.pi/agent/settings.default.json > ~/.pi/agent/settings.json
# OR your overlay's real settings.json, symlinked.
```

## Checking the pi pin

`scripts/check-pin-drift.sh` asserts that the `pi` a shell would actually launch
is the version this repo is built against. Exit codes: **0** pinned and
matching, **1** drift, **2** it could not tell.
