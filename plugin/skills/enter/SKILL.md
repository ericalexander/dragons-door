---
name: enter
description: Enter Dragon's Door, the daily-turn BBS door game. Use when the player runs /dragons-door:enter or says they want to play the game, fight in the forest, raid someone, or check the realm news.
argument-hint: [action]
---

Load the `narrator` skill and enter the game.

0. **Title screen.** The first time the game starts in this conversation, before anything else in your reply, print the title screen below exactly as written, inside a ```text code block, with nothing added or changed. Skip it if you've already shown it earlier in this conversation, or if `$ARGUMENTS` names an action.

```text
                                       ▄▄▄██
               ▄▄                 ▄▄████▀▀ █▌
              ▐██▄▄▄         ▄▄████▀▀ ▐█  ▐█
          ▄▄▄▄████████▄  ▄▄███▀▀  ▐█  ▐█  █▌
        ▄███▀▀ ● ▀█████▌▐█▀▀  ▐█  ▐█  █▌ ▄█▀
       ▐██▀       ▐█████▐█▄▄▄▄██▄▄██▄▄██▄█▀
░░▒▒▓▓▓▓█▀▀█▀█▀▄   ███████▄▀▀▀▀▀▀▀▀▀▀▀▀▀▀           ▄
 ░▒▒▓▓▓▓▓▀ ▀ ▀    ▄██████████▄                    ▄█▌
    ░░▒▒         ▐██████████████▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄███▀
                  ▀████████████████████████████████▀
                   ▐████▀▀▀▀▀▀▀▀▀████▀▀▀▀▀▀▀▀▀▀▀▀
                   ▐███▌         ▐███▌
                  ▄████▄        ▄████▄

░█▀▄░█▀▄░█▀█░█▀▀░█▀█░█▀█░▀░█▀▀░░░█▀▄░█▀█░█▀█░█▀▄
░█░█░█▀▄░█▀█░█░█░█░█░█░█░░░▀▀█░░░█░█░█░█░█░█░█▀▄
░▀▀░░▀░▀░▀░▀░▀▀▀░▀▀▀░▀░▀░░░▀▀▀░░░▀▀░░▀▀▀░▀▀▀░▀░▀
```

1. Call the `status` tool. If it returns `not_registered`, ask for a name and class and call `register`.
2. If `$ARGUMENTS` names an action (forest, tavern, news, challenge <name>, …), do that. Otherwise, if there are `new_day` or `while_you_were_away` events, narrate them, then call `news` and give the headlines.
3. Print the status line and the menu from `actions`, and wait for the player.

Stay in the game until the player says they're done or asks for something unrelated to it.
