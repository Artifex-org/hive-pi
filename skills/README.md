# skills/ — shared general agent skills

General-purpose skills (SKILL.md format) meant for **every** consumer of hive-pi, not just this workstation.

How they're loaded:

- **Workstation pi**: `workstation/.pi/agent/settings.json` lists `~/repos/hive-pi__worktrees/main/skills` in `skills`.
- **Workstation Claude Code**: a dotfiles repo stows a symlink `~/.claude/skills/<name>` → `~/repos/hive-pi__worktrees/main/skills/<name>` (same pattern as the omarchy skill).
- **Hive-launched Claude Code**: does NOT read `~/.claude/skills`; it gets only the skills embedded in Hive's own plugin (`cmd/hive-agent/claude-plugin/skills/` in the hive repo). A skill launched Claude sessions need (e.g. `browser-use`) keeps a copy there — update both.
- **Other consumers** (bots, factory): point their agent's skills path at this directory in their hive-pi checkout. Cloud/factory pi runs with `--no-skills`.

Pi-specific, machine-specific skills stay in `workstation/.pi/agent/skills/`.
