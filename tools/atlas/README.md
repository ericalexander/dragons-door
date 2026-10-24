# Atlas

A maintainer's map of the whole world, for planning new places. Not part of the game.

1. Put play activity in `activity.json` (aggregate counts from the realm database; see `gen.mts` for the shape). It's gitignored.
2. `npx tsx tools/atlas/gen.mts tools/atlas` writes `world.json` from the same generator the game uses.
3. `python3 tools/atlas/build.py tools/atlas` writes `atlas.html`, a single self-contained page.
