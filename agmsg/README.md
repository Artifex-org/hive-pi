# The `pi` agent type for agmsg

[agmsg](https://agmsg.cc/) ships drivers for claude-code, codex, gemini, cursor,
opencode, copilot, grok and antigravity — but not for pi. This directory is that
driver. Without it `whoami.sh`, `join.sh`, `delivery.sh` and `spawn.sh` reject
`pi` as an unknown type, and the extension in
[`extensions/agmsg`](../extensions/agmsg/) has nothing to talk to.

Written to agmsg's public driver interface (a directory with a `type.conf`
manifest, discovered under `plugins/types/`), with no hive-pi-specific
assumptions — it is upstreamable as-is.

## Install

```bash
agmsg/install.sh              # link + trust
agmsg/install.sh --uninstall  # untrust + unlink
```

The script symlinks this directory into `~/.agents/skills/agmsg/plugins/types/pi`
and runs `agmsg plugin trust types/pi`. External drivers are shell code that
runs with your privileges, so agmsg ignores them until trusted — the trust record
pins the exact path, which is what makes trusting a symlink safe.

A symlink rather than a copy: the source of truth stays in this repo, so a
`git pull` on the workstation updates the driver with no reinstall. Re-run the
script after an agmsg upgrade that replaced `plugins/`.

## What each file decides

| File | Decides |
| --- | --- |
| `type.conf` | how pi is detected, how it is spawned, how a session is resumed, which delivery modes exist |
| `_delivery.sh` | writes `.pi/agmsg.json` — a mode, not a rule file |
| `_transcript-exists.sh` | whether a recorded session id still has a session file, so spawn resumes instead of starting fresh |
| `template.md` | the pi variant of the agmsg skill, for sessions running without the extension |

## The two non-obvious manifest choices

**`cmd_prefix=/`** — the boot prompt is `/agmsg actas <name>`, which is the
command the *extension* registers, not a skill invocation (`/skill:agmsg`).
That means a spawned agent claims its identity through the same code path a
human uses, and it keeps spawn's `MSYS_ARG_CONV_EXCL` guard active on Git Bash,
which only fires for the `/` prefix.

**`hooks_file=.pi/agmsg.json`** — every rule-file type writes prompt text into
the project telling the model to poll. pi's file contains one key, `mode`, and
instructs nobody: delivery is the extension's job, so there is no rule to drift
out of sync with the implementation.

## Session resume

`actas-claim.sh` records `team/agent → session id` when a role is claimed.
`_transcript-exists.sh` turns that id back into a file:

```
~/.pi/agent/sessions/--<cwd with / → ->--/<ISO-timestamp>_<uuid>.jsonl
```

The timestamp prefix means the uuid does not name the file, so the hook globs
for the suffix. Every failure path returns "not found", which makes spawn boot a
*fresh* session rather than resume a phantom id. `PI_CODING_AGENT_SESSION_DIR`
and `PI_CODING_AGENT_DIR` are honoured, in pi's own precedence order.

## Verifying an install

```bash
agmsg plugin list                      # types/pi -> trusted
agmsg whoami "$PWD" pi
agmsg delivery set monitor pi "$PWD"   # writes .pi/agmsg.json
agmsg delivery status pi "$PWD"        # mode: monitor
```
