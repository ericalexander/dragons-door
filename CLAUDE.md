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
- `server/src/world.ts` generates every tile from `DRAGONS_DOOR_WORLD_SEED` and its coordinates; nothing about terrain is stored. The live realm's seed and its town tiles (`DRAGONS_DOOR_TOWNS`, JSON like `{"ironhold":[x,y],"ashford":[x,y]}`) are private settings on the API's Vercel project; never commit them, and never put live coordinates in public files or committed migrations (run anything coordinate-specific directly against the database). The defaults in code are for local play only. Changing the seed or the generator reshapes the world under everyone's feet, so don't, once players have explored it.
- Stored: `players.pos_x/pos_y` (null = in town), `explored` (per player), `discoveries` (first finder of each tile).

## The atlas
- `tools/atlas/` builds a maintainer's map of the whole world (Eric's private artifact "Dragon's Door Atlas", https://claude.ai/artifact/FyR7WzHvjyBp4mGLDtJTQW). Refresh it whenever towns, caves or the generator change, and now and then for activity: query aggregate explored counts (real players, townsfolk) and discoveries into `tools/atlas/activity.json`, run `npx tsx tools/atlas/gen.mts tools/atlas` with the live `DRAGONS_DOOR_WORLD_SEED` and `DRAGONS_DOOR_TOWNS` from Vercel in the environment then `python3 tools/atlas/build.py tools/atlas`, and republish `tools/atlas/atlas.html` to that URL. Hand-placed places (the Hill Shrine and the like) are `place` rows in the private lore table; copy them into `tools/atlas/places.json` (gitignored) so the atlas draws them.

## The browser trial
- `server/src/trial.ts` runs dragonsdoor.gg/try: a server-side narrator (`TRIAL_MODEL`, Haiku by default) drives a trial character through the same endpoints as the plugin's tools, minus anything that reaches other players. Caps and switches are Vercel settings (`TRIAL_TURNS`, `TRIAL_PER_ADDRESS`, `TRIAL_PER_DAY`, `TRIAL_DAILY_USD`, `TRIAL_CLAIM_OPEN`, `TRIAL_OFF`). Its instructions are the `SYSTEM` prompt there; the full game's narrator skill is the reference for how places and menus should work.
- Every trial leaves a row in `trial_log` (moves, counts of what happened, tools used, narrator trouble, how it ended), and its transcript for 30 days. Eric's private dashboard "Dragon's Door Trials" (https://claude.ai/artifact/4cjWfnc4FJC2QRbnos9QB5) reads it live through his Supabase connector; it needs no refreshing.
