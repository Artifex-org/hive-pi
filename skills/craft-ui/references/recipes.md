# Component recipes

Each recipe: anatomy → state table → implementation sketch. Sketches are given in Tailwind-v4/cva form (shadcn-style hosts) and the state tables are framework-neutral contracts — port them to plain CSS when the host has no Tailwind. All tokens come from the project profile; in shared/library code, CSS vars carry fallbacks: `var(--ease-snap, cubic-bezier(0.2, 0, 0, 1))`.

State table columns used below: **rest / hover / active (pressed) / focus-visible / disabled** — plus component-specific states. Every recipe implements all five; none may be a no-op.

---

## 1. Button (function key)

Anatomy: label (+ optional leading icon 16px), raised body, crisp 1px-offset shadow.

| State | Spec |
|---|---|
| rest | raised: `shadow-[0_1px_0_var(--shadow-edge)]` (crisp, not blurred); solid or outline surface per variant |
| hover | surface lightens/darkens one step (`color-mix` 8%); cursor pointer; ≤ `--duration-150` |
| active | **compresses**: `translate-y-px` + shadow collapses to `0 0 0`; `--duration-100`, `--ease-snap` |
| focus-visible | 2–3px ring in accent (`ring-[var(--ring)]`), offset so the ring reads as a halo, never replaces the border |
| disabled | 50% opacity, `pointer-events-none`, shadow removed (a key that can't be pressed isn't raised) |
| loading | label swaps to spinner *of the same width* (no layout shift); button stays pressed-looking |

```tsx
// cva base additions (host button keeps its variants):
"transition-[transform,box-shadow,background-color] duration-150 ease-[var(--ease-snap,cubic-bezier(0.2,0,0,1))]",
"shadow-[0_1px_0_0_color-mix(in_oklab,var(--foreground),transparent_85%)]",
"active:translate-y-px active:shadow-none",
"focus-visible:ring-[3px] focus-visible:ring-ring/50",
"disabled:opacity-50 disabled:shadow-none disabled:pointer-events-none"
```

## 2. Toggle / Switch

Anatomy: track (well), thumb (key), optional silkscreen caption left/above.

| State | Spec |
|---|---|
| rest (off) | track = inset well (`--card-2` + inner shadow, ~1.5px depth); thumb raised: sheen highlight on its top edge (`inset 0 1px 0 <sheen>`) + crisp key shadow |
| hover | thumb's key shadow sharpens (invites the press) |
| active | thumb squishes ~10% wider in the travel direction while dragging/pressing |
| checked | thumb **travels** the track (`translate-x`, ~180ms, `--ease-glide`); track goes **full accent** with a darkened inset — a low `color-mix` of accent into the well reads as mud, especially on dark surfaces (user-confirmed). On/off differs in luminance, not hue alone |
| focus-visible | ring around the whole track |
| disabled | track and thumb flatten (no shadows), 50% opacity |

```tsx
// track
"bg-[var(--card-2,theme(colors.muted))] shadow-[inset_0_1.5px_3px_color-mix(in_oklab,var(--foreground),transparent_82%)]",
"data-[state=checked]:bg-[var(--accent,var(--primary))] data-[state=checked]:shadow-[inset_0_1.5px_3px_rgb(0_0_0/0.22)]",
// thumb — sheen token: light theme ~rgba(255,255,255,.65), dark ~rgba(255,255,255,.07)
"shadow-[inset_0_1px_0_var(--key-sheen),0_1px_1px_var(--key-edge)]",
"transition-transform duration-[180ms] ease-[var(--ease-glide,cubic-bezier(0.3,1.12,0.35,1))] data-[state=checked]:translate-x-5"
```

## 3. Checkbox / Radio

| State | Spec |
|---|---|
| rest | small inset well (the empty slot) |
| hover | border sharpens to full contrast |
| active | well deepens (inner shadow +1 step) |
| checked | mark **draws in** (checkbox: stroke-dashoffset or scale-in ≤ `--duration-150`; radio: dot scales from 0 with `--ease-settle`); fill takes accent |
| focus-visible / disabled | as button |
| indeterminate (checkbox) | horizontal bar, same accent — never an ambiguous half-opacity check |

## 4. LED status badge / dot

Anatomy: LED dot + uppercase caption (e.g. `● RUNNING`), or dot alone in dense tables with a tooltip.

- Dot: 7px, status token fill + same-color glow (`box-shadow: 0 0 6px 1px color-mix(... 40% transparent)`).
- Off/idle: hollow dim outline — lit vs unlit is the color-blind-safe cue.
- Live states (running/syncing) may breathe: opacity 1 → 0.6 → 1 over 2s, paused under reduced motion. Error LEDs do **not** blink (alarm fatigue); they are steady + labeled.
- Caption in silkscreen register; status word, not a sentence.

## 5. Stepper / wizard

Anatomy: discrete step slots (dots or short segments) + current-step label; content region.

- Track: countable slots that fill as completed (`--status-ok` or accent), current slot enlarged or ringed.
- Step transition: outgoing content fades/slides 8px in the direction of travel, incoming follows; `--duration-300`, `--ease-settle`; **direction reverses when going back**.
- Each slot is a real button when steps are revisitable (full five states); otherwise plainly non-interactive (no hover response).

## 6. Input / Select / Textarea

| State | Spec |
|---|---|
| rest | inset well (`--card-2`, hairline border, faint inner shadow) — visibly *below* the surface, fields are slots |
| hover | border to full contrast |
| focus | border → accent + ring; inner shadow eases out (the field "rises to meet you"), `--duration-150` |
| disabled | flattened, well removed, 50% opacity |
| invalid | border + caption swap to `--status-error`; message appears in caption register below, `--duration-200` slide-fade; never color-only — icon or text always present |
| with caption | silkscreen caption above, 4–6px gap; required-mark is part of the caption |

## 7. Card / Panel

Anatomy: surface from the elevation ramp, optional silkscreen header row, content, optional footer rail.

- Elevation by ramp (`--card` → `--card-2` → `--card-3`), not by growing shadows; hairline `--border` everywhere.
- Header: silkscreen caption + optional LED/status right-aligned — an instrument's panel section, not a headline.
- Interactive cards (links) behave as buttons: hover lifts one ramp step, press compresses. Static cards never hover-lift (a panel that reacts but isn't pressable is a lie).
- Radius from the profile scale; nested elements step the radius down (outer 8 → inner 6 → controls 4), never up.

## 8. Tabs / Segmented control

- One **sliding indicator** (pill or underline bar) moves between items — ~180ms, `--ease-glide` (settle's bounce reads toy-like on short travel); labels change weight/color only.
- The thumb is a **machined key**, not a flat pill: sheen highlight on its top edge (`inset 0 1px 0 var(--key-sheen)`), a border one contrast step above the track's, and a crisp 1px drop edge — riding in a track that is a visibly deeper well (`inset 0 1.5px 3px`) than a text field. Flat thumb + shallow track is the most common way this control loses its physicality.
- Inactive labels stay fully legible (muted-foreground, not 40% gray).
- Keyboard: arrow keys move selection, indicator animates the travel; focus ring rides the focused tab.
- N segments: thumb width `calc(100%/N - padding-compensation)`, travel in `translateX` steps of 100% of its own width — this generalizes past 2 segments without per-mode offsets.
- **Touch targets are hit areas, not visual heights.** Below the desktop breakpoint the ≥44px floor applies to the *effective tap target*; inflating the control's visual height to 44px makes it read clunky and off-instrument (user-confirmed). Keep the compact visual (~30px) and extend the hit area invisibly: `position: relative` on the button plus `::before { content:""; position:absolute; left:0; right:0; top:-8px; bottom:-8px; }`. Verify by tapping *outside* the visible bounds, and by arithmetic (visual height + 2×extension ≥ 44), not by eyeballing.
- **Mobile-primary variant** (a pane/view switcher that IS the page's navigation below the desktop breakpoint): full content width, `grid` with equal tracks — never content-sized or edge-aligned — uppercase micro-labels, and a raised thumb sliding on an inset track (thumb width = one padded track; `translateX` in steps of 100% lands it under each key). The desktop segmented control is a different, smaller instrument; reusing it here violates the touch-chrome hard rule. If the views also swipe, the thumb's travel is the swipe made visible — same order, same easing.

## 9. Numeric / stat readout

Anatomy: silkscreen caption, value in tabular numerals, optional unit and delta.

- `font-variant-numeric: tabular-nums` mandatory; mono face when the host profile provides one and the value is data-dense (ids, hashes, money columns).
- Value ≥ 2× caption size; unit in caption register beside the value, not inside it.
- On change: one background pulse or single scale tick (1 → 1.02 → 1), `--duration-300`; never odometer-scroll digits for vanity. Delta gets sign + period ("+2.4% vs last week") with a paired arrow so color isn't the only cue.
- A readout with a time-series behind it wants a sparkline → that's `dataviz` territory; keep the tile, delegate the mark.
- **Digits deserve a chosen face, not the system fallback.** `ui-monospace` resolves to whatever the OS ships (often DejaVu on Linux) and reads as unconsidered — a user will notice (confirmed). When the host profile has no data face, inline one as a woff2 data URI (CSP-safe, ~15KB/weight; IBM Plex Mono is a proven instrument-grade default) for every numeric surface: readouts, tables, axis labels.
- **LCD register** (hero readouts on instrument-flavored surfaces): a genuine seven-segment face (DSEG7, OFL, ~5KB woff2) with a **ghost-segment underlay** — the all-segments-lit pattern (`88:88.8`) absolutely positioned behind the value at ~8% ink opacity. That is how a real LCD looks, so it passes the "encodes something true" test; it is not costume. Keep every glyph the same size so ghost and value align; `aria-hidden` on the ghost. One LCD register per view — it is the display, not a text style.

## 10. Scroll rail

Any scrolling well (tables, lists, code panes) styles its scrollbar — the OS default breaks the instrument illusion instantly (user-confirmed on a lap table).

```css
.well-scroll { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.well-scroll::-webkit-scrollbar { width: 8px; }
.well-scroll::-webkit-scrollbar-track { background: transparent; }
.well-scroll::-webkit-scrollbar-thumb {
  background: var(--border); border-radius: 4px;
  border: 2px solid var(--card); /* inset thumb — reads as a slot rail */
}
.well-scroll::-webkit-scrollbar-thumb:hover { background: var(--muted-foreground); }
```

## 11. Instrument dial (gauge / clock / meter face)

For circular gauges, clocks, and analog meters. Generate ALL ticks programmatically (a loop over `polar(cx, cy, r, deg)`) — never hand-author path data.

- **Banded architecture, like a watch dial**: an outer *rehaut* band of hairline micro-ticks (fine graduations, ~0.45px stroke at 55% ink) → a hairline separator ring → the main tick track (minor 1px, major 2.2px every Nth) → numerals on their own radius, clear of both tick bands. One emphasized numeral (weight, not size) marks the origin. The banding is what separates "fine instrument" from "clean SVG clock".
- **Shaped hands, not lines**: a tapered polygon (wider at the pivot, ~0.6px at the tip) + a counterweight stem and disc past the pivot. Wrap each hand in a `<g>` and rotate the group — animation code never touches the geometry. Pivot: ink disc + small accent cap.
- **Sub-registers are wells**: a sub-dial recesses — face one ramp step darker (`color-mix` ink 4%), a hairline lip ring just outside its edge, and a micro-caption (~6px silkscreen) naming its unit. A register that floats flat on the face reads as printed-on, not built-in.
- The indicating hand takes the accent; everything else stays in the surface/ink ramp.
- Five-state contract does not apply (a dial is a display, not a control) — but live state on it follows motion.md's mechanical patterns (flyback, stop settle).

## 12. Toast / inline alert

- Slides in from an edge 8–12px with fade, `--duration-300` `--ease-settle`; leaves faster than it arrived (`--duration-150`).
- Left edge carries a 3px status rail + LED dot; body text in normal register; the title states what happened, the body what to do next.
- Errors are steady (no shake, no blink) and never auto-dismiss while an action is available.
## 13. Liquid-glass overlay (sheet / dock / palette / toast / pill)

The material contract for detached chrome above scrolling content (aesthetic.md §Liquid-glass overlay) — not a new component: sheets, docks, palettes and toasts keep their own recipes; glass replaces their *surface*.

| Aspect | Spec |
|---|---|
| fill | `--glass` — translucent tint of the panel color; alpha tuned so the composite over ANY backdrop keeps body text ≥4.5:1. Compute the worst case (fill over black in light theme, over white in dark); ~0.72 light / ~0.75 dark alpha are proven starts |
| backdrop | `blur(var(--glass-blur, 16px)) saturate(var(--glass-boost, 1.5))` + the `-webkit-` twin — Safari/iOS PWAs need the prefix |
| edge | `--glass-edge` hairline border + `inset 0 1px 0 var(--glass-sheen)` specular top |
| shadow | whatever detached-overlay shadow the host already allows; glass doesn't change it |
| stacking | ONE glass layer per stack: the scrim beneath stays plain tinted `color-mix` (a blur through a blur silently no-ops). The glass element must be the animated element itself or sit outside any `filter`/`will-change` ancestor subtree |
| fallback 1 | `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))` → `background: var(--panel)` opaque |
| fallback 2 | `@media (prefers-reduced-transparency: reduce)` → opaque panel + filters off (the a11y branch — and the perf escape for low-power kiosks; large blur regions jank wall tablets, so also keep the radius ≤20px). On kiosk/PWA products, mirror this branch behind a root attribute (e.g. `:root[data-transparency="reduce"]`, same opaque contract, incl. hover states) driven by an in-app settings toggle — the OS setting is out of reach on a mounted wall tablet |

```css
.glass {
  background: var(--glass);
  -webkit-backdrop-filter: blur(var(--glass-blur, 16px)) saturate(var(--glass-boost, 1.5));
  backdrop-filter: blur(var(--glass-blur, 16px)) saturate(var(--glass-boost, 1.5));
  border: 1px solid var(--glass-edge);
  box-shadow: /* host's detached shadow */ 0 -8px 30px color-mix(in oklab, var(--ink), transparent 80%),
              inset 0 1px 0 var(--glass-sheen);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .glass { background: var(--panel); }
}
@media (prefers-reduced-transparency: reduce) {
  .glass { background: var(--panel); -webkit-backdrop-filter: none; backdrop-filter: none; }
}
```

- **Verify by pixels, never by eye**: place a saturated element behind the glass, sample pixels through it vs beside it — `getComputedStyle` proves the declaration, the pixel delta proves it painted. Blur is precisely the effect a downscaled screenshot hides.
- Text on glass keeps the normal ink ramp; if a muted/faint register drops below its on-panel contrast in the worst-case composite, promote it one ink step *inside glass surfaces* rather than raising the fill alpha for everyone.
