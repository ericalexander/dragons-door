---
name: lord
description: Enter Dragonmoor, the daily-turn text RPG. Use when the player runs /lord or says they want to play the game, fight in the forest, raid someone, or check the realm news.
argument-hint: [action]
---

Load the `narrator` skill and enter the game.

1. Call the `status` tool. If it returns `not_registered`, ask for a name and class and call `register`.
2. If `$ARGUMENTS` names an action (forest, tavern, news, challenge <name>, …), do that. Otherwise, if there are `new_day` or `while_you_were_away` events, narrate them, then call `news` and give the headlines.
3. Print the status line and the menu from `actions`, and wait for the player.

Stay in the game until the player says they're done or asks for something unrelated to it.
