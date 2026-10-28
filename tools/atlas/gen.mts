// Builds the atlas data: every tile within R of Brightwater, from the same generator the game uses, plus play activity.
import { readFileSync, writeFileSync } from "node:fs";
const { tileAt, TOWN_TILES, POCKET, setPlaces } = await import("../../server/src/world.js");
const dir = process.argv[2] ?? new URL(".", import.meta.url).pathname;
const R = 18;
// Hand-placed places (the shrine and the like) live in the private lore; put them in places.json (gitignored) to draw them.
try { setPlaces(JSON.parse(readFileSync(`${dir}/places.json`, "utf8"))); } catch { /* none */ }
const TER = ["town", "meadow", "forest", "marsh", "hills", "crags"];
const names: string[] = []; const nameIx = new Map<string, number>();
const tiles: (number | string)[][] = [];
for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
  const t = tileAt(x, y);
  const nm = x === 0 && y === 0 ? "Brightwater" : t.name;
  if (!nameIx.has(nm)) { nameIx.set(nm, names.length); names.push(nm); }
  tiles.push([TER.indexOf(t.terrain), t.level, t.poi === "cave" ? 1 : t.poi === "town" || (x === 0 && y === 0) ? 2 : t.poi === "shrine" ? 3 : 0, nameIx.get(nm)!]);
}
const activity = JSON.parse(readFileSync(`${dir}/activity.json`, "utf8"));
const towns = [{ id: "brightwater", name: "Brightwater", x: 0, y: 0, note: "mages and priests start here; Grey Hob keeps the old north toll-bridge" },
  ...Object.entries(TOWN_TILES).map(([id, t]) => ({ id, name: (t as { name: string }).name, x: (t as { x: number }).x, y: (t as { y: number }).y,
    note: id === "ironhold" ? "warriors and guardians start here; Old Grudge under the broken bridge; the forge" : id === "ashford" ? "thieves and bards start here; Nan Silt at the ford; the Undercroft; Mags Pell's music room" : "" }))];
const out = { generated: new Date().toISOString().slice(0, 10), seed: process.env.DRAGONS_DOOR_WORLD_SEED ? "the live realm's (private)" : "dragons-door-world-1 (local)", radius: R, pocket: POCKET, terrains: TER, names, tiles, towns, activity };
writeFileSync(`${dir}/world.json`, JSON.stringify(out));
console.log("tiles", tiles.length, "names", names.length, "caves", tiles.filter((t) => t[2] === 1).length, "bytes", JSON.stringify(out).length);
