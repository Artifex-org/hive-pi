# skillscope

Per-skill, per-project scoping for a skill library that is otherwise global.

## Why

Our settings point pi at the entire Claude Code skill library (`~/.claude/skills`)
plus the hive-pi skills, in **every project**. pi puts every loaded skill's name
and description in the system prompt of every session, so a Aurora session carries
`borealis-hedge-review` and an Aurora session carries `aurora-order-walkthrough`. The
library is global; relevance is per-project. This closes that gap.

The idea is salvaged from [`supi-skills`](https://github.com/badlogic/pi-skills);
the implementation is ours, because pi's extension API does not offer what that
package assumed.

## Scopes

| scope | in the system prompt? | model may load it? | `/skill:<name>` |
|---|---|---|---|
| `auto` (default) | yes | yes | yes |
| `manual` | no | no | **yes** |
| `off` | no | no | yes — see *Limits* |

`manual` is pi's own `disable-model-invocation` frontmatter flag lifted from
per-file-forever to per-project: the skill stays a first-class command you can
invoke, it just stops competing for the model's attention in projects where it is
irrelevant.

## Config

**Absent config means everything is `auto`** — that is, today's exact behaviour.
Installing this extension changes nothing at all until you configure it.

Two files, both optional, both the same flat shape:

- user: `~/.pi/agent/hive-telemetry/skill-scope.config.json`
- project: `<repo>/.pi/skill-scope.json`

```json
{
  "default": "off",
  "e2e-tests": "auto",
  "fix-sentry": "auto",
  "deploy": "manual"
}
```

`default` is a reserved key setting the fallback for skills with no entry of their
own; every other key is a skill name. The example above is the intended shape for
a focused repo: nothing is advertised except what this repo actually does.

**The project file overrides the user file per key**, so a project that names
three skills does not discard your opinion about the other ninety. The project
file is read **only in a trusted checkout** (`/trust`) — pi refuses to load
project skills from an untrusted directory, and a file that re-scopes them
deserves the same bar.

An unrecognised value drops that one entry, never the whole file: a typo must
cost you one line, not silently restore "everything auto" for everything else.

### Why not `~/.pi/agent/skill-scope.json`

The path above is what `configPathFor("skill-scope")` yields, and every
config-carrying extension in this repo goes through that one function. The state
directory name is frozen for the reason documented in
`extensions/hive-common/identity.ts`.

## `/skills`

Lists every loaded skill with its resolved scope, plus both config paths and
whether the project file was applied. It is registered even when nothing is
configured, because "everything is auto, and here is where you would say
otherwise" is the answer you need on the day you install this.

## How it works

pi 0.84.1 has **no skill-filtering API** — `ExtensionAPI` carries
`getActiveTools`/`setActiveTools` for tools and nothing equivalent for skills, and
`resources_discover` can only *add* `skillPaths`. But the shape that
`extensions/plan/` uses for tools still applies: the prompt is advisory, the call
is where enforcement happens.

1. **Advisory — `before_agent_start`.** pi hands the handler the full loaded skill
   list (`systemPromptOptions.skills`) and accepts a replacement system prompt.
   pi assembles the prompt with `prompt += formatSkillsForPrompt(skills)`
   verbatim, so re-formatting the `auto` subset and splicing it over the original
   block is exact. This is where the attention saving comes from. The replacement
   is deterministic for a given skill list and config, so the prompt prefix stays
   cacheable across turns.
2. **Enforcement — `tool_call` on `read`.** pi's own prompt block instructs the
   model to auto-select a skill *by reading its SKILL.md*, so refusing that read
   refuses auto-selection. This is needed because the advisory half is only a
   prompt: a model that saw the description in an earlier turn, or in its own
   compaction summary, can still name the path.

The two scopes block **different things**, and the asymmetry is deliberate:

- `manual` blocks **SKILL.md alone**. `/skill:<name>` injects SKILL.md, whose
  whole job is then to send the model to `references/*.md` and `scripts/`. Those
  reads are model-initiated; blocking the directory would break the skill for the
  user who asked for it by name.
- `off` blocks **everything under the skill directory**. There is no legitimate
  invocation left to protect. One exception, and it matters: pi also loads a
  loose `foo.md` sitting directly in a skills directory as a skill, and gives it
  that *shared* directory as its `baseDir`. Scoping such a skill `off` blocks
  **that file only** — otherwise turning off one skill would take every sibling
  in the library with it. A skill owns its directory exactly when its file is
  named `SKILL.md`, which is pi's own rule (it does not recurse into a directory
  that has one).

Paths are matched the way pi's read tool resolves them, not with a bare
`path.resolve`: `~`, a leading `@`, `file://` and pi's unicode-space
normalization all get applied first. `tool_call` hands over the model's raw
argument, so every spelling pi accepts has to be a spelling the block accepts —
`~/.claude/skills/<name>/SKILL.md` is the obvious one, and it is exactly how the
library this extension exists to scope is addressed.

## Limits

Named rather than papered over — each one is a real hole:

- **`/skill:<name>` typed by the user always works, including for `off`.** pi
  expands it inside `agent-session` before any event an extension can see, and it
  never touches the read tool. Treat `off` as "the model will not reach for this
  here", not as a lock.
- **Enforcement arms on the first turn that fires `before_agent_start`.** The read
  block needs to know which skills are loaded, and that list only arrives with
  that event. Turns *injected* by another extension never emit it (see
  `extensions/agenda/index.ts`, which re-asserts its tool set on the inject path
  for exactly this reason), so a session driven entirely by injected turns runs
  with the block dormant. The prompt-side scoping is unaffected. `session_start`
  clears the cache, so this also applies for one turn after `/reload`.
- **Only the `read` tool is gated.** `bash cat <skill>` is not covered, and
  neither are pi's `grep`/`find`/`ls` tools — a determined model can still see a
  scoped-out skill's text through them. This gates the documented selection path
  (pi's prompt block says to load a skill *with the read tool*); it is not a
  sandbox. Blocking shell reads would mean classifying every command, which is
  `extensions/plan/policy.ts`'s job and a much larger blast radius.
- **Symlinks are not resolved.** Path containment is computed with `path.relative`
  (segment-aware, so `/skills/foo` does not match `/skills/foobar`) but without
  `realpath`, because the matcher is pure and runs in an event handler. This is
  not hypothetical here: several entries under `~/.claude/skills/` are stow
  symlinks into `a dotfiles repo` (and one into `/usr/share/omarchy`), so the same
  skill has two spellings on disk and only the one pi actually loaded — the one
  it prints in `<location>` — is matched.
- **If pi changes how it formats the skills block, the splice stops finding it.**
  The prompt is then left untouched — scoping is simply not applied, rather than a
  prompt edited on a guess — and `/skills` reports the failure, because otherwise
  it would be silent.

## Files

- `scope.ts` — pure: parsing, merge, `resolveScope`, `partitionSkills`,
  `swapSkillsBlock`, `blockedSkillRead`. No fs, no clock. This is what the tests
  import.
- `index.ts` — pi wiring. All file reads happen in the factory, never in a
  handler.
- `test/skillscope.test.ts` — resolution, partition, prompt surgery, path
  containment, and the wired handlers driven through the fake pi.
