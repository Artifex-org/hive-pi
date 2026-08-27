# Project design profile

The skill is parameterized: recipes and devices consume a small set of project-specific values. Those values live in a **profile**. Canonical home: `docs/design-profile.md` in the target repo (checked first, then `.claude/design-profile.md`). If none exists, derive one with the checklist below, state your derived parameters in the session, and offer to commit the profile file.

## Template

```markdown
# Design profile — <project>

## Tokens
| Role | Token | Notes |
|---|---|---|
| page background / foreground | … | |
| surface ramp (1→3) | … | raised vs inset comes from this ramp |
| accent / ring | … | ONE accent |
| status ok / warn / error / info | … | **three shapes, three tokens per status**: the LED *fill* (`--status-X`, for dots/chips/solid pills) + its on-fill legend (`-foreground`); the *tinted surface* (`-bg`, text on it is the page's normal ink); and a *text-grade ink* (`-text`, ≥4.5:1 on that theme's card AND page, per theme — measure it). A profile that has only the fill and reuses it as text, or reuses `-foreground` on `-bg`, is the contrast regression one measured sweep hit across all 11 of a project's themes. + off/idle treatment |
| border / hairline | … | |
| glass (floating-layer material) | … | fill + edge + sheen + blur + boost; the fill alone carries ≥4.5:1 worst-case (recipes §13); omit when the project has no floating chrome |
| brushed metal (chassis finish) | … | grain + hi + lo; grain below text contrast, chrome only (aesthetic §Brushed-metal finish); omit when unused |
| muted foreground (captions) | … | silkscreen register color |

## Scales
- Radius: … (outer→inner stepping)
- Durations: … (press/state/toggle/enter roles)
- Easings: … (snap/settle/exit — or "use skill fallbacks")

## Type
- UI face: … · Mono/tabular: … · Caption register: size/tracking/case

## Icons
- Library: … · Default size: … · Stroke: …

## Component idiom
- Primitive layer path: …
- Variant mechanism (cva/classes/…): …
- Import path consumers use: …
- data-attribute conventions: …

## Theming
- Mechanism (class / data-theme / media): …
- Themes shipped: … (every change must hold in all)
- Reduced-motion: global rule at … (do not duplicate per component)

## Hard constraints
- e.g. "no new runtime deps", "primitive layer is a shared package — separate repo/PR, all var() need fallbacks"

## Verification
- Commands (typecheck/lint gates), dev-server URL, screenshot route(s)
```

## Discovery checklist (no profile found)

1. Find the token source: Tailwind v4 → `@theme` blocks in the imported CSS; Tailwind ≤3 → `tailwind.config.{js,ts}`; else global CSS `:root` blocks or a theme provider.
2. Find the primitive layer (`components/ui`, a design-system package, or a vendored library) and read Button + one form control to capture the idiom.
3. Find the theming mechanism: search for `data-theme`, `.dark`, `prefers-color-scheme`, theme-provider components; enumerate shipped themes.
4. Check for duration/easing tokens; if absent, plan to add them (token layer first) rather than hardcoding.
5. Check icon usage (which library, typical size) and numeric conventions (tabular-nums anywhere?).
6. Note constraints from repo docs (CLAUDE.md/AGENTS.md/contributing): dependency policy, shared packages, gate commands.
---

## Worked examples

A repository's own profile is the canonical one; this template is what you derive
when it has none. An organisation running this harness typically keeps its filled-in
profiles in its private overlay, beside the rest of its machine configuration.
