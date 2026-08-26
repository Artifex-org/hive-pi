---
name: craft-ui
description: Frontend design-engineering skill for handcrafted, instrument-grade UI in the retro-modern (Teenage Engineering-inspired) idiom — buttons, toggles, steppers, badges, readouts and panels with rich physical interaction feedback, high-contrast visual clarity, and deliberate state/step transitions. Use it BEFORE writing or restyling any UI component, page, or widget, in any framework — it supplies a device vocabulary, per-component recipes with full state tables, a motion timing system, and a project-profile mechanism so results blend into an existing design system instead of forking it. Charts and dashboards-of-charts are delegated to the dataviz skill. Triggers on "craft ui", "frontend design", "design a page", "design a component", "restyle", "redesign", "polish the UI", "make this look good", "widget", "microinteractions", "interaction feedback", "hover state", "press state", "button", "toggle", "switch", "stepper", "badge", "retro-modern", "teenage engineering", "handcrafted UI".
---

# craft-ui — handcrafted, instrument-grade interfaces

Build interfaces the way Teenage Engineering builds hardware: every control looks operable, every operation answers with physical feedback, and every mark on the panel earns its place. The output must read as *engineered*, not decorated — and in an existing product it must read as *native*, not bolted on.

## Scope — and the one hard delegation

This skill owns components, pages, layout, typography, color language, iconography, motion, and interaction feedback. It does **not** own charts: for any chart, graph, plot, sparkline-heavy dashboard, or data visualization, stop and load the **`dataviz`** skill, passing it the project profile's palette and surfaces as its design-system parameters. Stat tiles and numeric readouts stay here; the moment axes or series appear, it's dataviz's job.

## Design stance

1. **Interfaces are instruments.** A control's appearance declares its affordance; its feedback confirms the operation. If a user can't tell what's pressable, or a press produces no response, the component is broken regardless of how it looks.
2. **Clarity through contrast.** Information hierarchy is carried by contrast — of lightness, weight, and size — on calm, high-legibility surfaces. Muddy mid-tones are the enemy.
3. **Ornament only where it encodes function.** An LED communicates state. A knurled edge communicates "grab here". A screw communicates nothing — it is costume, and gets a strict budget.
4. **Precision is the aesthetic.** Aligned grids, exact spacing, tabular numerals, consistent radii. The retro-modern look comes from machine-shop discipline, not from a filter.
5. **Blend, never fork.** In an existing product, express the language through the project's own tokens and idioms. A component that only looks right in one theme is a defect.

## Procedure — in order

1. **Determine the mode** — greenfield (new page/app, you set the direction) or brownfield (existing design system, you extend it). The workflows differ; brownfield starts with an inventory, greenfield with a brief. → `references/process.md`
2. **Load the project design profile.** Look for `docs/design-profile.md` (then `.claude/design-profile.md`) in the target repo. If none exists, derive one from the repo's tokens/config using the discovery checklist, state your derived parameters, and offer to commit the profile. Every color, radius, duration, and font you use afterwards comes from this profile — no exceptions. → `references/project-profile.md`
3. **Compose from the vocabulary.** Pick the devices that encode this view's functions (LED for state, well for input, silkscreen label for grouping…), respecting the restraint budget, then build each component from its recipe — anatomy, full state table, exact classes/CSS parameterized by profile tokens. → `references/aesthetic.md`, `references/recipes.md`
4. **Apply motion.** Durations and easings come from the timing system (press ≲150ms, state ~200ms, entrance ~300ms; `snap`/`settle` easings; `prefers-reduced-motion` branch mandatory). → `references/motion.md`
5. **Charts → dataviz** (see Scope above). Feed it the profile; do not invent a second chart style.
6. **Critique loop.** If a browser/screenshot capability is available (the native `browser_*` tools, chrome-devtools, playwright, claude-in-chrome MCP): render, screenshot at two widths and in each theme the project ships, critique against the checklist, iterate. If not (a session without any of those): run the static critique — re-read the diff against the recipes' state tables and the hard rules, and end your report with a short "please eyeball" list for a human. Select the path by *available capability*, never by guessing the environment. → `references/process.md`
7. **Validate.** Run the audit script **that ships with this skill**, resolving its directory FIRST as a separate statement:

   ```bash
   C=$(ls -d ~/.claude/skills/craft-ui ~/repos/hive-pi*/main/skills/craft-ui 2>/dev/null | head -1); "$C"/scripts/audit-hardcoded-colors.sh <changed paths>
   ```

   Both statements in ONE bash call (`;`-joined) — but **never the inline-assignment form `CRAFT_UI=/path "$CRAFT_UI/scripts/…"`**: the shell expands `$CRAFT_UI` before the assignment takes effect, so it runs `/scripts/audit-hardcoded-colors.sh` (measured, `No such file or directory`, 2026-08-20). **A bare `scripts/audit-hardcoded-colors.sh` is equally wrong**: bash runs it from the TARGET REPO, where no such file exists — three agents hit `No such file or directory` on it in hive (2026-08-16/17/19) and validated nothing. The script exits non-zero on raw palette utilities or hex literals; it scans WHOLE FILES, so on a file with pre-existing raw utilities triage its findings against your diff — fix what your change introduced, and leave legacy hits on lines you did not touch (note them, don't restyle unrelated code to get to zero). Walk the a11y floor: visible `:focus-visible` on every interactive element, reduced motion honored, contrast ≥ 4.5:1 for text, hit targets ≥ 40px on touch surfaces, state never encoded by color alone.

## Hard rules

- **Tokens only.** Every color comes from the project profile's token map. Never invent a hex value; never use a framework's raw palette utility (`bg-blue-500`) in product code. The audit script enforces this.
- **Five states minimum.** Every interactive element defines rest, hover, active/pressed, focus-visible, and disabled. A recipe's state table is a contract, not a suggestion.
- **Durations from the scale.** Only the profile's duration/easing tokens (with the skill's fallbacks). No ad-hoc `duration-[137ms]`.
- **Restraint budget.** At most two decorative devices per view; functional devices (LEDs, wells, labels) are unlimited but each must encode something true.
- **Materials have domains.** Liquid glass only on the detached floating layer (sheets, docks, palettes, toasts — recipes §13, with both fallback branches); brushed metal only as a finish on structural chrome, one element per surface. Glass on an in-flow card or metal on a content panel is a defect, not a variation (aesthetic.md §Hardware honesty).
- **Respect the host idiom.** In a cva/shadcn codebase, ship recipes as cva variants; in plain CSS, as classes. Match naming, file placement, and composition patterns already in the repo.
- **Touch surfaces get touch chrome.** Never reuse a desktop-scale control (content-sized `text-xs` segmented control, `py-1` buttons) as a mobile layout's primary navigation or switcher — dropped into a phone column it sits off-axis, undersized, and reads as an afterthought. A touch-primary control spans the full content width with equal tracks and shows its state with a sliding indicator (see the tabs recipe's mobile variant). The hit-target floor (≥44px below the desktop breakpoint) applies to the **effective tap area, not the visual height**: keep compact instrument proportions and extend the hit area with an invisible `::before` inset when needed (tabs recipe) — inflating the visual to meet the floor is its own defect. The floor binds at build time — it is not a step-7 validation afterthought — and is verified by arithmetic and out-of-bounds taps, not by eye. Corner-anchored overlays (toasts, update prompts) follow the same axis rule: bottom-right on desktop, bottom-center on mobile.
- **Copy is silkscreen.** Labels short, unambiguous, sentence case for prose / uppercase micro-labels for panel captions; an action keeps the same name through its whole flow.
- **No visible defaults.** A browser or OS default showing anywhere in the surface — scrollbar, system-fallback numerals, default easing, an unstyled focus ring — is a finding, not a neutral. Every default is either deliberately kept or replaced from the profile.
- **Meet the reference bar.** `references/process.md` §"The reference bar (CM-12)" defines the standing quality floor: displays with architecture, controls with mechanism, physical feedback, measured (not eyeballed) verification of hit areas, theme states, and mid-flight motion. Build to it or explicitly report what fell short — never silently ship below it.

## Reference index

| File | The question it answers |
|---|---|
| `references/aesthetic.md` | What does "TE retro-modern" concretely consist of, and how do I keep it from becoming costume? |
| `references/recipes.md` | How exactly do I build a button / toggle / stepper / badge / readout / panel, state by state? |
| `references/motion.md` | Which duration, which easing, which choreography — and when to not animate? |
| `references/process.md` | What's the workflow for greenfield vs brownfield, and how do I critique my own output? |
| `references/project-profile.md` | How do I plug this skill into a specific project's design system? (Template + derivation checklist.) |
