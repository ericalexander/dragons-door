---
name: enter
description: Enter Dragon's Door, the daily-turn BBS door game. Use only when the player runs /dragons-door:enter or explicitly asks to play Dragon's Door by name. Never start it on your own from words like news, forest, attack or fight in ordinary work.
argument-hint: [action]
---

Load the `narrator` skill and enter the game.

0. **Title screen.** Call the `status` tool first. Then, the first time the game starts in this conversation, before any other text in your reply, print the title screen below exactly as written, inside a ```text code block, with nothing else added or changed, except: replace `vX.Y.Z` with `v` + `client.version` from the status result, keeping its position. Skip the title screen if you've already shown it earlier in this conversation, or if `$ARGUMENTS` names an action.

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
                                          vX.Y.Z
```

   **Update waiting.** If `client.update_available` is true, right after the title screen (or at the top of your reply if you skipped it), and only once per conversation, print this, filling in the versions:

   > *Something stirs inside you. You feel a new strength waiting to be claimed — but not in this body. Not yet.*
   >
   > Dragon's Door v`client.latest` is out (you have v`client.version`). To update: run `/plugin`, go to **Installed**, pick **dragons-door**, choose **Update now**, then run `/reload-plugins`. Your character is safe; it lives on the server.
   >
   > To get future updates without asking: `/plugin` → **Marketplaces** → **dragons-door** → **Enable auto-update**.

   Then carry on with the game as normal. Don't mention updates otherwise.

   **What's new.** If `client.whats_new` has entries, print them after the title screen (and after the update notice, if any), before anything else. It comes once, after an update. Open with one in-world line of your own, like *"You notice the realm has changed while you slept."*, then for each entry, oldest first, its `lore` in italics followed by its `plain` text on its own line, as written. Don't add features that aren't listed. Then carry on.

1. Use that `status` result. If it returns `not_registered`, ask for a name and class and call `register`.
2. If `$ARGUMENTS` names an action (forest, tavern, news, challenge <name>, …), do that. Otherwise, if there are `new_day` or `while_you_were_away` events, narrate them, then call `news` and give the headlines.
3. Print the status line and the menu from `actions`, and wait for the player.

Stay in the game until the player says they're done or asks for something unrelated to it.
