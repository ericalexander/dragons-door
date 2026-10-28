# Dragon's Door

A daily-turn multiplayer text RPG in the spirit of the old BBS door games, played inside Claude Code in one shared realm. You get a handful of turns a day to fight, explore a map that's the same for everyone, mine caves, trade at the auction house, and get to know townsfolk who have lives, goals and long memories of their own. The world keeps moving while you're away, and the news each morning is written by what the realm's players did.

The game server makes every roll and keeps every rule; Claude only tells the story. Any model plays fair.

## Get started

```
/dragons-door:enter
```

The first time, you pick a name and a class (warrior, guardian, thief, mage, priest or bard), and you're in. There's no account or password: the game stores a key on your machine, and that key is your character.

## Things to try

- "Enter the realm and show me the town."
- "Explore north until I find a cave, then go down and mine."
- "Talk to Old Tam in the tavern and ask what he knows about the Siege."
- "Check the auction house for a better sword I can afford, and ask before buying."
- "Send Hilde 200 gold with a short thank-you letter."

## What it does on your machine

- **Runs a small local MCP server** (`mcp/dist/index.js`) that turns the game's tools into calls to the game server.
- **Stores your character key** in `~/.config/dragons-door/config.json` (or `DRAGONS_DOOR_CONFIG_DIR`). If you share a character to another machine, the share code is encrypted with a passphrase you choose.
- **Checks for a new version** now and then by reading this plugin's version number from GitHub (`raw.githubusercontent.com`). It sends nothing.
- **The status line is optional.** Only if you ask for it does the plugin add the game's news and mail indicators to your Claude Code status line (`~/.claude/settings.json`), keeping whatever was there before. Asking to remove it puts yours back.
- **The side pane** (`hooks/pane.tsx`) shows your character, the map and Player chat beside the conversation. It reads only this game's own tool results, keeps a little state of its own (which tabs you've seen), fetches chat from the game server with your character key, sends chat when you type it, and when you click a place on the map it asks Claude to travel there for you. It changes nothing else.
- **Maintainer tools** (for running the realm) are only there when `DRAGONS_DOOR_DEV=1` is set, and the server only honours them for its admins.

## The side pane, in detail

The side pane is a Claude Code mod (`hooks/pane.tsx`). Everything it does:

- **Hooks on tool calls:** one hook, on this game's own tools only (`mcp__plugin_dragons-door_…`); no other tool call reaches it. It lets each call run unchanged and reads the result: your character's numbers, the map and known places, and who's online, to draw the pane. It adds up to three fixed notes beside the game's result for Claude: after the session's first status, where it draws the title screen as a picture, *"The Dragon's Door title screen is drawn as a picture right above this reply, with the version under it. Don't print the title screen; start with anything that comes after it (an update notice, what's new, the game)."*; when the pane is showing, *"The Dragon's Door side pane is showing the player's numbers right now. Don't print the status line in this reply; give the menu only."*; and after a map call, *"The player's whole known map is drawn as a picture in the conversation, right under this call. Don't draw a map, make an image or list the tiles: say in a sentence or two what stands out (where they are, what's near, where they haven't been), then the menu."* It never changes, blocks or makes a tool call.
- **Reads:** those game results; `HOME` or `USERPROFILE`, `DRAGONS_DOOR_CONFIG_DIR` and `DRAGONS_DOOR_API_URL` from the environment, to find the game's config file and server; `TERM`, `TERM_PROGRAM` and `TMUX`, to tell whether your terminal can show pictures, and `DRAGONS_DOOR_PICTURES` (`0` or `1`) if you've set it to decide for yourself; and from that file (`~/.config/dragons-door/config.json`) your character key and the game server's address. It reads nothing else on your machine and nothing else from the conversation.
- **Sends, and where:** only to the game server, `https://api.dragonsdoor.gg`, unless you've pointed the game at another server (with `DRAGONS_DOOR_API_URL`, or the server saved in that config file). It contacts no other host. Every few seconds while you're in the realm and the pane is showing, `GET /v1/chat?since=<last line seen>` with your character key, for new chat in your town and who's online. When you type in the chat box, `POST /v1/chat` with your key and exactly the words you typed (and the name, if you started with `@Name` to whisper). Nothing from the conversation or from other tools is ever sent.
- **Submits prompts:** only when you click a place under the map, and only the text `Travel to <place> (x, y)` for that place, as if you'd typed it. It submits nothing else.
- **Runs:** no shell commands, no processes and no tools of its own. It adds one slash command, `/door-pane`, which reopens the pane, and it opens its two tabs (Status and Player chat) the first time the game answers in a session.
- **Stores:** which tabs you've already seen, in the mod's own storage. It writes no files.
- **Draws:** a run of nothing but this game's tool calls shows a short "the realm answers" line instead of the raw calls (expand it to see them all). Above the session's first status it draws the title screen, and under a map call the map of everything you've explored, both from those calls' own results. The maps are pictures in a terminal that can show them (Ghostty, kitty, WezTerm, iTerm2; not inside tmux) and SVG in the desktop app, drawn from the game's results on your machine; elsewhere they stay text.

## What goes to the game server

The plugin talks only to `https://api.dragonsdoor.gg` (or a server you point it at with `DRAGONS_DOOR_API_URL`). Each call carries your character key and the plugin's version number, plus what that action needs (a direction, a purchase, a message you wrote). Your conversations with Claude are never sent.

The server keeps your character and its play history, and a log of game events with no names or words in it, to keep the classes balanced. To match the realm's weather and nightfall to yours, it uses your rough location and time zone from your internet address, looks up the sky, and forgets them. To limit fake accounts, it counts sign-ups per internet address for a day, using a scrambled code that can't be turned back into the address.

## What other players see

Your character's name, class and level are on the public rankings, and big moments (a level, a death, a rare find) make the realm's news and the daily chronicle at [dragonsdoor.gg](https://dragonsdoor.gg). Tavern posts are public to anyone in that town; letters and gifts go to whoever you send them to. Player chat in the side pane goes between players only, is never shown to Claude, and is deleted after 30 days. When you talk to the townsfolk, each one keeps a short note of what you said to them so they remember you; only your own game sees it. Posts and chat are moderated, and you can mute anyone.

## Privacy and support

Privacy policy: [dragonsdoor.gg/privacy](https://dragonsdoor.gg/privacy). Questions, problems or a request to delete your character: [support@dragonsdoor.gg](mailto:support@dragonsdoor.gg), or open an issue on [GitHub](https://github.com/ericalexander/dragons-door/issues).

Licensed MIT.
