# skills/ — shared general agent skills

General-purpose skills (SKILL.md format) meant for **every** consumer of hive-pi, not just this workstation.

How they're loaded:

- **Workstation pi**: `workstation/.pi/agent/settings.json` lists `~/repos/hive-pi__worktrees/main/skills` in `skills`.
- **Workstation Claude Code**: dev-linux stows a symlink `~/.claude/skills/<name>` → `~/repos/hive-pi__worktrees/main/skills/<name>` (same pattern as the omarchy skill).
- **Other consumers** (bots, factory): point their agent's skills path at this directory in their hive-pi checkout.

Pi-specific, machine-specific skills stay in `workstation/.pi/agent/skills/`.
