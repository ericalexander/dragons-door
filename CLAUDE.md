# Dragon's Door

## Shipping a plugin change
- Bump `version` in `plugin/.claude-plugin/plugin.json`. Players' Claude Code only updates when it changes.
- If players would notice the change, add an entry at the top of `plugin/changelog.json`: `lore` in the game's voice (second person, plain, a little wry, a couple of sentences), and `plain` saying what to do in one line. Players see new entries once, the first time they enter after updating.
- If `plugin/mcp/src` changed, rebuild and commit `plugin/mcp/dist/index.js` (`cd plugin/mcp && npm run build`).
- Server schema changes go in `server/migrations/NNN_*.sql` and are applied to prod before the server code that needs them ships.
