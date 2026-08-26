# Motion

Motion is feedback and orientation, never atmosphere. Default implementation is **CSS-only** — transitions, keyframes, and `linear()` easing cover everything in the recipes. Reach for a JS motion library only when the work is gesture-driven (drag with physics) or layout-projection (FLIP reorder) — and treat adding that dependency as an architectural decision for the host project, not a styling choice.

## Duration roles

Use the host profile's duration tokens; these are the roles and defaults:

| Role | Token (fallback) | Use |
|---|---|---|
| press | `--duration-100` (100ms) | active/pressed compression, key travel down |
| state | `--duration-150` (150ms) | hover, focus ring, color/border shifts, key travel up |
| toggle | `--duration-200` (200ms) | thumb travel, sliding indicators, check/dot draw-in |
| enter | `--duration-300` (300ms) | content entering: toasts, dialogs, step transitions, reveals |
| emphasis | ≤ 500ms | one-off attention pulses (value changed); rare |

Rules of thumb: feedback ≤ 150ms (it must feel simultaneous with the input); anything over 500ms is a cutscene — don't. Exits run one role faster than entries (things leave quicker than they arrive).

## Easing set

```css
/* snap — fast out, hard stop: presses, hovers, anything that must feel mechanical */
--ease-snap: cubic-bezier(0.2, 0, 0, 1);

/* settle — slight overshoot then rest: content entrances, draw-ins.
   linear() spring approximation; fallback to a plain ease-out where linear() is unsupported. */
--ease-settle: linear(0, 0.4157 18.7%, 0.7509 33.3%, 0.9673 47.5%, 1.0791 61.9%, 1.0951 69.3%, 1.0765 76.2%, 1.0075 92.5%, 1);

/* glide — firm landing with ~2% overshoot: sliding indicators, toggle thumbs,
   anything that travels a track. settle's ~9% bounce reads as toy-like on a
   short-travel control (user-confirmed on a segmented control, 2026-08). */
--ease-glide: cubic-bezier(0.3, 1.12, 0.35, 1);

/* exit — ease-in, accelerating away */
--ease-exit: cubic-bezier(0.4, 0, 1, 1);
```

`settle` is the one place the interface admits it's playful — a physical overshoot like a real switch. Reserve it for content *entering* (toasts, step transitions, marker draw-ins). Anything sliding along a visible track — segmented-control thumbs, toggle thumbs, tab underlines — takes `glide`: the same mechanical intent, but the overshoot is barely perceptible, like a machined part seating. Never use either on presses (presses are rigid) or on exits.

## Mechanical patterns

These make a control feel like a mechanism rather than a styled div. Each is cheap; all are reduced-motion-safe by construction (state lands at its end value instantly under the global rule).

- **Return-to-zero (flyback).** When a reset sends an indicator (hand, needle, progress marker) back to its origin, animate the travel: ~300ms, `easeOutBack`-class curve so it dips just past zero before seating. The digital/text value zeroes *immediately* — only the physical indicator travels. Skip entirely under reduced motion.
- **Stop settle.** When a continuously-moving indicator halts, a decaying sub-degree wobble (~200ms, amplitude under 1% of range) sells the inertia. Never on discrete/stepped indicators — they are already rigid.
- **One animation slot per mover.** Every scripted animation of the same element shares a single cancel token (one `cancelAnimationFrame` slot), cleared at the top of every state change that could drive it. Two animations driving one hand/thumb/needle is how mechanisms glitch.
- **Detents.** A continuous input that snaps to steps (a knob, a slider with stops) gets a short `--duration-100` `--ease-snap` transition on its pointer/indicator transform: because the value quantizes, the pointer *clicks* from step to step instead of gliding. One CSS line; no JS.

## Choreography rules

- **Animate state, not layout.** Transition `transform`, `opacity`, `box-shadow`, `background-color`. Don't transition `width`/`height`/`top` in flows the user is working in (layout shift ≠ feedback). Compositor-friendly properties also keep it at 60fps.
- **One mover per moment.** A view change gets one orchestrated movement (the sliding indicator, the entering panel), not five parallel effects.
- **Stagger ≤ 3.** Entering lists may stagger the first three items by ~30ms; beyond that, appear as one block. Never stagger on exit.
- **Interruptible always.** Transitions must retarget mid-flight (CSS transitions do this natively — another reason to prefer them over fire-and-forget keyframe sequences on interactive elements).
- **Direction encodes meaning.** Forward = travel left/up-out, new content follows; back = reversed. A toast returns to the edge it came from.
- **No idle motion on working surfaces.** Breathing LEDs for live processes are the one sanctioned ambient effect; everything else moves only in response to the user or a real state change.

## Reduced motion — mandatory branch

Every animated pattern ships with:

```css
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 1ms !important; animation-duration: 1ms !important; animation-iteration-count: 1 !important; }
}
```

…or targeted equivalents (host projects usually have a global rule — check the profile; don't duplicate it per component). Semantics: state changes still *happen* instantly (opacity/position land at their end values); travel, pulses, and breathing are suppressed. Never gate *information* behind an animation.

## Implementation notes

- Put durations/easings in the token layer once (`@theme` in Tailwind v4 hosts) and consume via `var()` — recipes then need no per-component timing decisions.
- In shared/library code, always `var(--ease-snap, cubic-bezier(0.2,0,0,1))` — sibling consumers of the library may not define the tokens.
- `transition-[transform,box-shadow]` (explicit properties) over `transition-all` — `all` catches layout properties by accident and costs performance.
- Test `linear()` fallback: browsers without support ignore the declaration, so declare a plain `transition-timing-function: ease-out` first, then the `linear()` override.
