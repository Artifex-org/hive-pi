# hive-pi

The public [pi](https://github.com/earendil-works/pi) harness that ships with
[Hive](https://hiveci.io): extensions, subagent roles, prompt templates and
themes. It is what a Hive-provisioned machine gets out of the box, and it is
useful on its own to anyone running pi.

Distributed as a **pi package**. Consumers pin a release tag; a machine
provisioned by the Hive desktop app tracks a checkout that a timer keeps current.

```bash
pi install git:git@github.com:Artifex-org/hive-pi@v0.1.0
```

## Why this repo exists, and why it is not a fork

We do not fork pi. The short version:

- Upstream ships ~26 commits/day. A fork accrues ~800 commits/month of
  divergence in code we did not write.
- Everything we want is already extension-level: tools, providers (including
  auth and stream behaviour), widgets/footer/header/overlays/editors/renderers,
  CLI flags, commands, shortcuts.
- The SDK (`createAgentSession`, `InteractiveMode`, `runPrintMode`,
  `runRpcMode`) covers embedding pi in an application.
- MIT plus git means the fork option never expires. Exercising it is the only
  thing that costs.

## Layout

| Path | Loaded as | Notes |
| --- | --- | --- |
| `extensions/` | pi extensions | declared in `package.json` → `pi.extensions` |
| `prompts/` | slash commands | user-facing only; their descriptions are **not** visible to the model |
| `themes/` | themes | `aether-dark` / `aether-light` (default) and `kanagawa` |
| `agents/` | subagent roles | pi has no `agents` package resource, so `extensions/subagent/agents.ts` resolves this dir relative to itself |
| `skills/` | skills | `craft-ui` |
| `types/` | ambient declarations | hand-written types for runtime deps that ship none |
| `workstation/` | machine skeleton | defaults, the self-updater and its timer — **stowed, not installed**; see [workstation/README.md](workstation/README.md) |
| `agmsg/` | agmsg driver | the `pi` agent type for [agmsg](https://agmsg.cc/) — see [agmsg/README.md](agmsg/README.md) |
| `evals/`, `test/` | not shipped to pi | |

## What Hive adds

`extensions/hive-common`, `hive-remote` and `hive-telemetry` connect a pi session
to a Hive fleet: a launched agent registers its session, streams its transcript
to the workspace, and is steerable from it.

**All three are inert without configuration.** With no
`~/.pi/agent/hive-telemetry/credentials.json` they register nothing and the
session behaves as plain pi. Running this package outside a Hive fleet is a
supported, tested state, not an accident.

## Configuring it for your organisation

Four extensions need facts only your organisation has — which repos exist, which
knowledge collections belong to which checkout, which MCP servers are one
project's product, which MCP tools you have reviewed as read-only. They read one
optional file:

```
~/.pi/agent/house-profile.json
```

See `extensions/profile-common/profile.ts` for the shape and for exactly how each
consumer degrades when it is absent. **Absent is a supported state**: every site
falls back to the conservative answer rather than to a guess.

Machine configuration proper — `settings.json`, `mcp.json`, `AGENTS.md`, and any
organisation-specific agent roles — belongs in a private *overlay* repository
that is stowed into `~/.pi/agent/`. This repo deliberately contains none of it.

## Agent-to-agent messaging

Sessions on this harness can message each other — and agents on Claude Code,
Codex or Gemini CLI — over agmsg, a shared SQLite file with no daemon and no
network. Two halves, installed separately:

```bash
agmsg/install.sh            # teach agmsg about pi (once per machine)
/agmsg join <team> <name>   # register this project, then pick a delivery mode
```

## A note on the examples

Many comments here cite measurements — a run that took eight `wait_for_run`
calls, a branch name a tracker hands out that the repository cannot have, a
contrast regression across eleven themes. Those numbers are real; they are why
the code is shaped the way it is.

The repository, project and MCP-server names in them are **placeholders**.
`Aurora`, `Borealis`, `Borealis-Ops`, `aurorasvc`, `Cirrus` and `Alpha`/`Beta`
stand in for the private repositories the evidence was gathered in. Nothing in
this repo is configured for them, and `house-profile.json` is where your own
names go.

## Development

```bash
npm ci --ignore-scripts
npm run check      # tsc --noEmit && vitest run
```

## License

MIT. See [LICENSE](LICENSE).
