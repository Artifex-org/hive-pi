# settings

One page for every hive-pi toggle.

```
/toggles
```

Until now each extension owned a config file and, at best, a `-status` command
that printed it. That is fine when you already know which extension owns the
behaviour you want to change, and useless when you do not — which is the usual
case, and the reason this exists.

## The page

```
hive-pi settings

COMPACTION
› openai server compaction       [ OFF ]
    ⚠ sends conversation context to OpenAI and sets store:true, so OpenAI
      retains it server-side

EDITING
  filerank result ranking        [ ON  ]
  papercut friction log          [ ON  ]

SESSION
  narrate reminders              [ ON  ]
  terminal tab title             [ ON  ]
  per-skill scoping              [ ON  ]

TELEMETRY
  hive telemetry                 [ OFF ]
    ⚠ reports session metrics to hive under your API key
  hive remote control            [ OFF ]
    ⚠ streams this session to the hive agents workspace and accepts steering
      from it

↑↓ move · space toggle · esc close
```

`↑↓`/`jk` move, `space` or `enter` toggles, `esc`/`q` closes.

## Without a TUI

The overlay needs a real terminal. Headless, in RPC, and from a script the same
information comes back as text, and there is a direct form that works
everywhere — and is faster than the overlay even when the overlay would work:

```
/toggles                      # the page (or a text listing)
/toggles compaction           # one setting's state and its warning
/toggles compaction on        # set it
/toggles hive telemetry off   # labels work too, not just config ids
```

Names match on the config id or an unambiguous label prefix. `hive` is
deliberately rejected as ambiguous rather than resolved — the difference between
`hive-telemetry` and `hive-remote` is the difference between reporting metrics
and accepting steering.

## Two things the page owes you, and does

**A toggle does not take effect immediately.** Every extension here reads its
config once, in its factory, and several deliberately register nothing at all
when disabled (see `narrate/index.ts` on why a no-op handler is worse than no
handler). So a flag set here applies at the next session or after `/reload`, and
the page says so on every change rather than letting you conclude it is broken.

**A failed write never looks like a successful one.** Rows show what is on disk,
re-read after every toggle — not what you just pressed. A permissions error or a
concurrent hand-edit shows up as an error line and the old value, not as a lie.

## Warnings and hints

A **warning** shows always, including while the setting is off: a consequence
you only discover after enabling something is one you were never given the
chance to weigh. A **hint** shows only while it is on, because a caveat about
behaviour is noise for a thing that is not running.

## Where the values live

`~/.pi/agent/hive-telemetry/<name>.config.json` — the same files the extensions
already read, in the same format. This page is a view over them, not a new
source of truth, so hand-editing still works and still wins.

Toggling writes a **literal** boolean rather than deleting the key. Slightly
redundant-looking on disk, but it means what you set survives a later change to
the extension's own default — which a deleted key would not.

## Adding a setting

Add an entry to `registry.ts`. `test/settings.test.ts` then enforces that it
points at a real extension, that the declared `opt-in`/`opt-out` mode matches
the literal expression in that extension's source, that config ids are unique,
and that anything sending data off the machine both defaults OFF and carries a
warning.

That last pair is not a style rule. The registry is central rather than
self-registering — a disabled extension does not run, so a self-registering page
could only list what is already on, which is exactly backwards. The cost of
being central is drift, and the drift test is what makes it affordable. It
earned its place on its first run by catching a real mismatch: hive-telemetry's
reader lives in `identity.ts` while `index.ts` contains `enabled:` in a *writer*,
so a naive one-file search matched the wrong line.

## Not here

`agenda`/`conductor` (owns `/conductor on|off`, and its state is a lifecycle
rather than a flag) and `plan` (entered per task, not configured). A settings
page that lists things whose real control lives somewhere else teaches people to
look in the wrong place.
