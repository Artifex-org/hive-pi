# Process

Two modes, one shared discipline: design twice (plan, then critique the plan) before writing code once.

## Greenfield — new page, app, or surface

1. **Pin the brief.** One concrete subject, its audience, the view's single job. If the brief doesn't say, decide and state your choice — the subject's own world (its materials, instruments, vernacular) is where distinctive choices come from.
2. **Brainstorm 2–3 directions** in prose: for each, a one-line concept, the 4–6 named colors (as *roles* mapped to tokens you'll define), the type pairing, the layout in one sentence or an ASCII wireframe, and the **signature** — the single element this view will be remembered by.
3. **Self-critique before code.** For each direction ask: would I have produced this for any similar brief? (If yes, it's a template, not a choice — see the anti-templated list in `aesthetic.md`.) Does the signature encode something true about the subject? Does everything else stay quiet? Pick one direction, revise the weak parts, state what changed.
4. **Build**: define the token block first, then compose from `recipes.md`, motion from `motion.md`. Spend boldness in one place; keep the rest disciplined. Quality floor without announcing it: responsive to mobile, visible focus, reduced motion respected.

## Brownfield — existing design system (the common case)

1. **Inventory before touching anything.** Read the token source (theme CSS/config), the primitive layer, and 2–3 representative components. Record: token names, elevation ramp, radius scale, duration tokens, variant idiom (cva? classes?), import paths, theming mechanism (class? data-attribute? how many themes?).
2. **Load or derive the project profile** (`project-profile.md`). If the repo has `docs/design-profile.md`, it wins over anything you'd infer.
3. **Change the minimum surface.** Prefer, in order: (a) token additions, (b) primitive-level changes every consumer inherits, (c) per-component edits. Never fork the token system, never introduce a parallel styling idiom, never restyle by sprinkling overrides at call sites.
4. **Blend rule** (from `aesthetic.md`): character arrives through feedback, contrast, and micro-detail. The brand's hue and surfaces stay.
5. **Check the blast radius**: if the system ships multiple themes, your change must hold in every one (tokens with per-theme values, or theme-agnostic constructions). If the primitive layer is shared with other apps, every new `var()` needs a fallback.

## Copywriting is part of the design

- Words exist to make the interface easier to use; they're design material, not decoration.
- Name things by what users control, never by implementation ("Notifications", not "Webhook config").
- Active, specific verbs on controls: "Save changes", not "Submit". The action keeps its name through the flow ("Publish" → toast "Published").
- Silkscreen captions: ≤ 3 words, uppercase register, no punctuation.
- Errors say what happened and what to do next, without apologizing or hedging. Empty states are an invitation to act, not a mood.

## Critique loop — select by capability

**If a browser tool is available** (native `browser_*` tools, chrome-devtools MCP, playwright MCP, claude-in-chrome — check what's actually callable, don't guess from the environment):

1. Render the change (dev server or the project's preview route).
2. Screenshot at two widths (~1440 and ~390) — and in **each theme state the project ships**, including the un-stamped system state under `prefers-color-scheme` emulation, not just the explicit theme attribute (they are different code paths — see aesthetic.md §Token discipline).
3. **Exercise every interactive mode, not just the default view.** Each segment of a switcher, each toggle position, empty AND populated states, the running AND stopped state of anything live. A mode you never rendered is a mode you shipped blind — twice now the unrendered second mode carried the bug (a `[hidden]`-override showing two views at once; duplicate axis labels in an alternate chart mode).
4. **Measure, don't only look**, for the things screenshots can't judge:
   - Hit targets: read `getBoundingClientRect` and do the arithmetic against the 44px floor; if the target uses an invisible hit extension, *click outside the visible bounds* and assert the action fired.
   - Theme correctness: `getComputedStyle` on the token-sensitive elements in each theme state.
   - Mid-flight animation: sample the animated transform partway through (e.g. a return-to-zero should read past-zero at the overshoot) — a before/after screenshot pair proves nothing about the travel.
   - No horizontal overflow: `scrollWidth - clientWidth === 0` at the narrow width.
5. Critique against this checklist, then fix and re-shoot:
   - Are all five states of every touched control visibly distinct? (Hover and press with the pointer; tab to check focus.)
   - Contrast: any text you have to squint at? Any mid-gray-on-gray? Compute ratios for status-colored text and text-on-accent (white-on-accent is a repeat offender: ~4:1, fails small text).
   - Alignment: baselines, gutters, control heights — anything off-grid?
   - Restraint: count decorative devices; over budget?
   - Anti-template check: does the view resemble a known default?
   - Themes: does any element visibly ignore a theme (leaked hardcoded value)?
   - Fonts: did every numeric surface get the chosen data face, or is a system fallback showing? (Check `document.fonts.check(...)` when faces are inlined.)

**If not** (pi and other headless harnesses) — static critique:

1. Re-read the final diff against the recipes' state tables: verify every touched interactive element declares all five states, durations use tokens, every color is a token reference.
2. Run the skill's own `scripts/audit-hardcoded-colors.sh` on changed paths — by the path the skill was loaded from, NOT a bare `scripts/…`, which bash resolves against the target repo (where it does not exist). See SKILL.md step 7.
3. Mentally walk one realistic user flow through the change; note any state you couldn't verify.
4. End the report with a **"please eyeball"** list: the specific screens, themes, and interactions a human should look at, and what to look for.

## Definition of done

- Recipes' state contracts met; audit script clean; a11y floor walked (focus, contrast, reduced motion, hit targets, no color-only state).
- Verified in every shipped theme **state** (visually AND computationally, or explicitly flagged for a human when running headless).
- Every interactive mode rendered at least once; live values driven through a real state change, not just the initial paint.
- The one-sentence answer to "what makes this view feel crafted?" names a device that encodes function — not a decoration.

## The reference bar (CM-12)

The standing quality floor is the CM-12 chronograph build (2026-08): a surface is done when it would sit next to it without looking like the cheaper instrument. The full source ships with this skill at `assets/cm12-chronograph.html` — a single self-contained file (open it in a browser, or read it for the token-block structure, the dial construction, the flyback/settle animation slot, the segmented-control and toggle CSS, and the LCD register). Concretely, that bar means — beyond the checklist above:

- **Displays have architecture**: banded dials, recessed sub-registers, ghost-segment LCDs — not flat shapes with values printed on them (recipes.md §9, §11).
- **Controls have mechanism**: machined thumbs in deep wells, detent-snapped knobs, glide-eased indicators, flyback returns (recipes.md §2, §8; motion.md §Mechanical patterns).
- **Every default is a decision**: the scrollbar, the numeral face, the easing curve, the checked-track color. If a browser or OS default is visible anywhere in the surface, it was chosen — or it's a finding.
- **Feedback is physical**: every state change answers with travel, luminance, or a single pulse — and never more than one mover per moment.

When a session cannot reach this bar in the available time, say so and list what was left below it — silently shipping under-bar work is the failure mode this section exists to prevent.
