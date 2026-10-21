# Dragon's Door

## Shipping a plugin change
- Bump `version` in `plugin/.claude-plugin/plugin.json`. Players' Claude Code only updates when it changes.
- If players would notice the change, add an entry at the top of `plugin/changelog.json`: `lore` in the game's voice (second person, plain, a little wry, a couple of sentences), and `plain` saying what to do in one line. Players see new entries once, the first time they enter after updating.
- If `plugin/mcp/src` changed, rebuild and commit `plugin/mcp/dist/index.js` (`cd plugin/mcp && npm run build`).
- Server schema changes go in `server/migrations/NNN_*.sql` and are applied to prod before the server code that needs them ships.
- If a release breaks older plugins (a tool's request or response changed shape), set `MIN_PLUGIN_VERSION` on the API's Vercel project to that version. Players below it are turned away with the update steps. Leave it unset otherwise.

## Checking balance against real play
- `select * from balance_by_class;` on the realm database summarizes real players (townsfolk excluded) by class: fights, win rate, deaths, crits, loot, level-ups.
- Raw rows are in `game_events` (kinds: day_start, fight_end, death, level_up, loot, pvp, song, spend, dragon_slain). Compare against `npx tsx src/sim.ts <class>`.

## The world map
- `server/src/world.ts` generates every tile from `DRAGONS_DOOR_WORLD_SEED` (default `dragons-door-world-1`) and its coordinates; nothing about terrain is stored. Changing the seed or the generator reshapes the world under everyone's feet, so don't, once players have explored it.
- Stored: `players.pos_x/pos_y` (null = in town), `explored` (per player), `discoveries` (first finder of each tile).
