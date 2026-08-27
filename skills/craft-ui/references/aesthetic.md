# The retro-modern language

What Teenage Engineering hardware (OP-1, TX-6, TP-7, EP-133) actually does, translated into UI devices you can build. Each device below states what it *communicates*; if a device would communicate nothing in your view, don't use it.

## Principles

- **Hardware honesty.** Surfaces are flat and matte; depth is used only to mean something (raised = pressable, inset = accepts input, flush = static). Exactly two non-matte materials exist, each with a hard domain: **liquid glass** is the material of the detached floating layer — fixed chrome and overlays that live *above scrolling content* (see the device below) — and a defect anywhere in-flow; **brushed metal** is a finish for structural chrome that already claims machining (chassis rails, dock plates, bezels), never for a content panel. Everything else: no gratuitous gradients, no soft-glow bloom, no translucency.
- **Silkscreen typography.** Two registers: normal UI text (the host product's type), and *panel captions* — small (10–11px), uppercase, letterspaced (`tracking-wider`), muted, often paired with a value in tabular numerals. Captions label groups and readouts the way silkscreen labels a device panel.
- **High-contrast panels.** Content sits on calm, near-neutral surfaces with a clear elevation ramp; text is decisively dark (or light), never mid-gray-on-gray. Contrast carries hierarchy so color doesn't have to.
- **Color as signal.** One accent color, used for the current action and focus. Status colors (ok/warn/error/idle) appear only where state genuinely exists, always paired with a non-color cue (shape, label, position). Everything else stays in the surface ramp.
- **An LED color is a fill, not an ink.** Status tokens are calibrated as *emitters* (the dot, the chip, the solid pill) — mid-to-high lightness so they read as lit. Used as text on a light surface they land at ~1.5–2:1 and fail; their `-foreground` companion is the legend-on-the-emitter color, so it fails the other way on a *tinted* status background (same polarity, ~1.2:1 — measured across one product's 11 themes, broken in 10). Three legal shapes, no others: solid emitter + its legend; tinted status surface + the page's normal ink (the tint carries state); standalone status text/icon in a dedicated text-grade `-text` token per status, tuned per theme (darker in light themes, lighter in dark). A token sweep that maps "green text" to the emitter token produces exactly this regression — judge by lightness, not hue. **And verify both polarities before calling a fix done**: that sweep's first correction moved status text onto the chip-fill family, which passed in light (4.6–7.6:1) and failed in dark (1.9–3.2:1) — caught by the pre-commit reviewer, not by the author, because the author had measured one theme. Neither fill family is text-safe on both sides; only a purpose-built ink is.
- **Grid discipline.** Controls sit in machined slots: consistent gutters, aligned baselines, shared control heights, radii from one scale. Optical alignment beats box alignment for icons and numerals.

## Device vocabulary

Every CSS sketch is parameterized by profile tokens (`var(--…)`); always ship fallbacks in host code that other consumers share.

### Functional devices (unlimited use, must encode something true)

**LED indicator** — communicates a live state (running, armed, error, idle).
Small dot (6–8px) filled with a status token plus a soft same-color glow; off-state is a visibly hollow/dim dot, so state is never color-alone (lit vs unlit is a luminance cue).
```css
.led { width: 7px; height: 7px; border-radius: 999px;
  background: var(--status-ok); box-shadow: 0 0 6px 1px color-mix(in oklab, var(--status-ok), transparent 40%); }
.led[data-state="off"] { background: transparent; box-shadow: none;
  border: 1.5px solid color-mix(in oklab, var(--muted-foreground), transparent 50%); }
```

**Inset well** — communicates "this area accepts input" (text fields, selects, drop zones, empty slots).
One step *down* the elevation ramp plus a hairline inner edge; the inverse of a raised button.
```css
.well { background: var(--card-2); border: 1px solid var(--border);
  box-shadow: inset 0 1px 2px color-mix(in oklab, var(--foreground), transparent 92%); }
```

**Function-key button** — communicates "pressable, with travel". Raised at rest (crisp small shadow, *not* blur-heavy), compresses on press: shadow shrinks and the key moves down 1px. The travel is the feedback.

**Toggle travel** — a switch's thumb physically slides its track; checked state adds an LED-tint to thumb or track. Sliding + tint = two cues.

**Silkscreen caption** — communicates grouping/meaning of a control or readout. `font-size: 10–11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted-foreground);` Never more than ~3 words.

**Segment readout** — communicates a live value. Tabular numerals (`font-variant-numeric: tabular-nums`), optionally mono, sized decisively larger than its caption; value changes may pulse once (see motion.md), never scroll-animate for vanity.

**Sliding indicator** — communicates the selected item in a set (tabs, segmented controls): one physical bar/pill that *moves* between positions rather than restyling each item in place.

**Step/progress track** — communicates position in a sequence: discrete slots (dots/segments) that fill, not a smooth anonymous bar, when the steps are countable.

**LCD segment display** — communicates a live value on an instrument-flavored surface: a real seven-segment face with a faint all-segments ghost underlay behind the lit digits (recipes.md §9 "LCD register"). Honest, not costume — that is how an LCD physically reads. One per view.

**Scale-ticked knob** — a rotary input whose surrounding tick arc shows the value range and lights up to the pointer. The ticks are functional (they encode the scale); a knob without them is just a circle. Must be a real `role="slider"` with drag + arrow keys + wheel, detent-snapped (motion.md §Mechanical patterns).

**Scroll rail** — a scrolling well's scrollbar, styled as a slot rail from tokens (recipes.md §10). The OS-default scrollbar on an otherwise crafted panel is a defect, not a neutral.

**Liquid-glass overlay** — communicates "this chrome floats above live content; the page continues beneath". The one sanctioned translucency, and only for detached layers: bottom sheets, docks/tab bars that content scrolls under, command palettes, toasts, pills. Physics, all three or none: a tinted fill that ALONE carries text contrast (≥4.5:1 over the worst-case backdrop composite — fill over pure black in a light theme, over pure white in a dark one; the resting screenshot proves nothing), a bounded backdrop blur with a saturation boost so the pooled content stays alive (blur 12–20px, saturate 1.4–1.8 — atmosphere, never the legibility mechanism), and a specular top edge (inset 1px sheen + hairline border). One glass layer per stack: backdrop-filter does not compound through another filtered layer, so the scrim beneath a glass sheet stays plain tinted `color-mix`. Every use ships the two fallback branches (recipes.md §13): `@supports`-not → opaque panel; `prefers-reduced-transparency` → opaque panel + filters off (doubles as the low-power-kiosk perf escape). In-flow cards, wells, panels stay matte — glass on a card is exactly the templated look this skill exists to avoid.

### Decorative devices (budget: ≤ 2 per view)

**Knurled/ridged edge** — a fine repeating stripe on a drag-handle or divider edge, hinting "grab here". Only where dragging is real.
```css
.knurl { background-image: repeating-linear-gradient(90deg,
  var(--border) 0 1px, transparent 1px 4px); }
```

**Notch / chamfer accents** — a clipped corner or notch on a panel; pure character. One per view, if at all.

**Punched grid** — a dot-grid texture on an empty region (empty states, drop targets). Must stay below text contrast.

**Pixel/dot-matrix flourish** — a tiny dot-matrix animation or glyph in an empty state or loader. This is the "playful" TE note: allowed exactly once, where the user waits or the screen is empty — never on working surfaces.

**Brushed-metal finish** — a *finish*, not a device: it adds no marks, it tints existing structure, and it does not count against the two-device budget — its own budget is **at most one brushed element per surface**, and only on structural chrome (header rail, dock plate, LCD/dial bezel), never a content panel. Communicates "this element is the instrument's chassis". Anisotropic micro-grain over a soft vertical sheen; the grain obeys the punched-grid rule (below text contrast) and must survive non-integer DPR without moiré — stripe alpha ≤0.06, period ≥3px.
```css
.brushed { background-image:
  repeating-linear-gradient(180deg, var(--metal-grain) 0 1px, transparent 1px 3px),
  linear-gradient(180deg, var(--metal-hi), var(--metal-lo)); }
```

## Anti-templated-design calibration

Generated UI clusters around known defaults. If your draft resembles any of these, it wasn't designed — re-make the choice deliberately:

- Purple/indigo gradient hero + glass-blur cards in the content flow + emoji-as-icons. (Glass belongs to the floating layer only — see the materials rule; on an in-flow card it is this cliché.)
- A wall of identical `rounded-2xl` cards with icon-in-tinted-circle headers.
- Warm cream page + high-contrast serif display + terracotta accent (the current "tasteful" default).
- Near-black page + single acid-green accent.
- Numbered markers (01/02/03) on content that isn't actually a sequence.
- `shadow-md` on everything; centered everything; gray-on-gray text at 40% contrast.

The retro-modern language can itself decay into costume: knobs nobody can turn, fake screws, skeuomorphic speaker grilles. The test for every device: *what does it communicate?* No answer → cut it.

## Token discipline across theme states

A themed product usually has **more theme states than themes**: an explicit light choice, an explicit dark choice, and the un-stamped "system" state where only `prefers-color-scheme` decides. Every token must be defined in *every* block that serves a state — the classic failure is a token added to the explicit-dark block but not the media-query dark block (or vice versa), so system-dark users silently get the light value. This exact bug shipped once because a `replace_all` edit matched only one of two differently-indented dark blocks. Two rules:

- When adding a token, grep for every block that redefines the ramp and add it to each — count the blocks first, then confirm the same count of insertions.
- Verify **computationally**, not visually: read `getComputedStyle` of the affected element in each state (system-dark emulation with no stamp, explicit stamps both ways). A screenshot of one dark path does not cover the other.

## Brownfield rule

In an existing product the language arrives through **feedback, contrast, and micro-detail — not through a palette coup**. Keep the brand's surfaces and hue; add press travel, LED state, wells, captions, sliding indicators, and tightened alignment. (A worked case: a warm-paper brand identity stays; the TE character lands in the primitives and details.) If you find yourself redefining the brand's primary color to orange, you've left the brief.
