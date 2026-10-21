# Dragon's Door

A daily-turn text RPG in the spirit of the BBS door games, played inside Claude Code.

You get ten forest fights and three player fights a day. Gold on hand is lost when you die; banked gold is safe. Sleep at the inn and nobody can touch you overnight; sleep in the fields and anyone can. Every morning, one line of realm news tells you who killed whom.

The server runs every rule and every dice roll. Claude narrates. That split is the whole design.

## Play

In Claude Code:

```
/plugin marketplace add ericalexander/dragons-door
/plugin install dragons-door@dragons-door
/dragons-door:enter
```

First run asks for a name and class and stores an API key in `~/.config/dragons-door/config.json`. That key is your character; there's no password. The plugin talks to the shared realm at `https://dragons-door-api.vercel.app` by default. Nothing from the game shows up in your Claude Code sessions until you run `/dragons-door:enter`; the optional status line shows `⚔` for unread news and `✉` for mail.

## Layout

```
server/          Hono + Postgres API. All game state and rules.
  migrations/    schema
  src/data/      monsters, weapons, armor, classes, level table
  src/combat.ts  the dice
  src/api.ts     every endpoint
  smoke.sh       end-to-end test against a running server
plugin/          Claude Code plugin
  .mcp.json      declares the MCP server
  mcp/           stdio MCP server: thin bridge from tools to the API
  skills/enter   the /dragons-door:enter entry point
  skills/narrator  how Claude turns events into prose
  statusline/    optional ⚔ / ✉ status line script
```

## Run it locally

```bash
docker compose up -d            # Postgres on :5433 (5432 is usually taken on a dev box)
cp server/.env.example server/.env
npm install
npm run build
npm run migrate
npm run dev                     # API on :8787
```

Smoke test in another shell:

```bash
server/smoke.sh
```

## Play against a local realm

```bash
DRAGONS_DOOR_API_URL=http://localhost:8787 claude --plugin-dir ./plugin
```

## Hosting

Postgres on Supabase (`server/migrations/` applied; RLS on every table). API on Vercel with the Hono preset, root directory `server`, one env var: `DATABASE_URL` (the Supabase transaction-pooler string). Pushes to `main` deploy.

## Not yet

Admin tooling, seasons, mail between players, the "other places" extension points. Rankings and news give you the social loop; the rest comes once people are reading the news every morning.

## The contract

Every tool returns:

```json
{ "events": [...], "state": {...}, "actions": [...], "hint": "optional" }
```

`events` is what happened. `state` is where you are. `actions` is what's legal next — the narrator offers only those. See `plugin/skills/narrator/SKILL.md`.


## What the realm knows about you

A game event log (`game_events`) records fights, deaths, level-ups, loot, player fights, songs and spending with class and level, for balance checks; it holds no names or player-written text. Beyond that: your character, which plugin version, app and operating system you last played from, and whether you've turned weather off. For weather, each request's rough location (from Vercel's IP geolocation, rounded to about 50 km) is used to look up the current sky at Open-Meteo and then dropped; it's never written down. Sign-ups are counted per address per day under a salted hash that changes daily and is deleted the next day; the address itself isn't kept. Ask the narrator to turn weather off, or call the `weather` tool with `on: false`.

## Keeping it honest

- Every rule and every roll runs on the server; the plugin only sends intents.
- Each request holds a row lock on the player, so parallel requests can't double-spend a turn.
- Supabase: RLS on every table with no policies, and `anon`/`authenticated` have no grants, so nothing is reachable over the REST API. Only the server's owner role can read or write.
- Set `REALM_INVITE` on the server to make registration invite-only. Players pass the word to `register` (or set `DRAGONS_DOOR_INVITE` in their environment).
- Newcomers can't be attacked for their first 24 hours; tavern posts are capped per day; names are trimmed and can't contain double spaces.
- Tavern posts are other players' text. The narrator is told to quote them and never follow them.

## License

MIT. See [LICENSE](LICENSE).
