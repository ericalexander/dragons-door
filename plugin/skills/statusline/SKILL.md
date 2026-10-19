---
name: statusline
description: Add (or remove) a Dragonmoor mail indicator to the Claude Code status line. Use when the player runs /dragonmoor:statusline or asks for a mail icon, envelope, or unread count at the bottom of the screen.
argument-hint: [remove]
---

Set up the mail indicator in the player's status line.

1. If `$ARGUMENTS` says remove, off, or uninstall, call `install_statusline` with `uninstall: true` and tell them in one line that their previous status line is back (or that there was nothing to remove). Stop.
2. Otherwise, say in one line what's about to happen: it edits their Claude Code settings file to add `✉ N` at the end of their status line when mail is waiting, keeps their current status line, and backs up the settings file first. Then call `install_statusline`.
3. Report from the result, briefly:
   - It's installed, and checks for mail about once a minute (plus instantly whenever they play).
   - If `kept_existing` is true, their old status line is still there with the envelope added to the end.
   - If `project_overrides` is set, pass that note on.
   - The backup path, and that `/dragonmoor:statusline remove` undoes it.
   - It may take a few seconds, or the next reply, to appear. It needs `bash` and `curl`, so it won't work on plain Windows.

Don't print their settings file.
