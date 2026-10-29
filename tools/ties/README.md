# Ties

A maintainer's map of how townsfolk feel about players and about each other (Eric's private artifact "Dragon's Door Ties"). Not part of the game.

1. Query the realm database for the raw facts into `raw.json` (people, talks, kept gifts, letters, robberies, finished quests, bonds; see `compute.mts` for the shape). It's gitignored: it holds player names.
2. `npx tsx tools/ties/compute.mts tools/ties` runs them through the game's own standing rules (`server/src/standing.ts`) into `ties.json`.
3. Put `ties.json` into `template.html` in place of `/*TIES*/null`, save as `ties.html`, and republish it to the artifact's URL.
