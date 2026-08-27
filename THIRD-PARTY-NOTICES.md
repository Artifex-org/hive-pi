# Third-party notices

This project is MIT (see [LICENSE](LICENSE)). Parts of it derive from, or
redistribute, the work below. Attribution lives here rather than in `LICENSE`
because inserting it there stops GitHub and automated scanners recognising the
file as MIT — they reported `NOASSERTION` while the paragraph sat between the
copyright line and the grant.

## Code

| Path | Derived from | Upstream licence |
|---|---|---|
| `extensions/subagent/` | `examples/extensions/subagent/` of `@earendil-works/pi-coding-agent` | MIT — Copyright (c) 2025 Mario Zechner |
| `extensions/plan/policy.ts` | `@narumitw/pi-plan-mode` (`narumiruna/pi-extensions`) | MIT — Copyright (c) 2026 narumiruna |
| `extensions/worktrees/session-move.ts` | `@thurstonsand/pi-wt` (`thurstonsand/wt`, `plugins/pi`) | MIT — Copyright (c) Thurston Sandberg |
| `extensions/claude-oauth/` | `paoloanzn/pi-black` | MIT — Copyright (c) 2025 Mario Zechner (fork chain from `earendil-works/pi`); full text in [`extensions/claude-oauth/LICENSE.pi-black`](extensions/claude-oauth/LICENSE.pi-black) |
| `extensions/edit-common/rowscript.ts` | The row-script **format** (`[path]`, `@REPLACE`, `@INS.*`, `@DEL`, `@@`, `++` escaping) as used by `mitsuhiko/agent-stuff` `extensions/unified-edit.ts` | Apache-2.0 — Copyright (c) Armin Ronacher. **No code was ported**: a verbatim-line comparison of the upstream file against this directory found one shared line, a `for` loop header. What was adopted is the on-the-wire format, which is not itself copyrightable. |
| `themes/kanagawa.json` | The Kanagawa palette and its colour names from `rebelot/kanagawa.nvim` | MIT — Copyright (c) 2021 Tommaso Laurenzi |

## Fonts

`skills/craft-ui/assets/cm12-chronograph.html` embeds subset WOFF2 payloads:

| Font | Copyright | Licence |
|---|---|---|
| IBM Plex Mono (Regular, SemiBold) | Copyright © 2017 IBM Corp. | SIL Open Font License 1.1 |
| DSEG7 Classic (Regular) | Copyright © 2018 keshikan | SIL Open Font License 1.1 |

The full OFL 1.1 text is in [`skills/craft-ui/assets/OFL.txt`](skills/craft-ui/assets/OFL.txt),
included because OFL §2 requires the licence to accompany each copy of the font.

**DSEG7 carries the Reserved Font Name "DSEG".** OFL §3 forbids a Modified
Version — which a subset is — from using it, so the embedded subset is declared
under the family name `CM12 Seven Segment`, not `DSEG7`.

## Runtime dependencies

All permissive, none copyleft: `@mozilla/readability` (Apache-2.0),
`asciichart` (MIT), `linkedom` (ISC), `playwright-core` (Apache-2.0),
`unpdf` (MIT); peer dependencies `@earendil-works/pi-*` and `typebox` (MIT).
