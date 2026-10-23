/**
 * Who wins when one player attacks another?
 * Uses the real PvP fight (combat.resolveDuel: each side uses its specials, spells and prayers;
 * attacker first) on characters taken from the solo simulator at the moment they reached each level,
 * so stats and gear are what a careful player would really have.
 *
 * First: SNAP=/tmp/x-<class>.json npx tsx src/sim.ts <class> 300   (for each class)
 * Then:  npx tsx src/pvp.ts <dir-or-prefix> [fights-per-cell]
 * DEFHP=0.6 starts the defender at 60% HP (someone caught after a day in the wild).
 */
import { readFileSync } from "node:fs";
import { GAME, type Player } from "./game.js";
import { playerAsFighter, resolveDuel, resolveFull } from "./combat.js";
import { manaMax } from "./game.js";

type Cls = "warrior" | "thief" | "mage" | "priest" | "guardian" | "bard";
const CLASSES: Cls[] = (process.env.PVP_CLASSES?.split(",") as Cls[]) ?? ["warrior", "thief", "mage", "priest", "guardian", "bard"];
type Snap = { class: Cls; level: number; max_hp: number; str: number; def: number; weapon_id: number; armor_id: number; trinket_id: number };

const prefix = process.argv[2] ?? "/tmp/pvp-";
const N = Number(process.argv[3] ?? 2000);
const DEFHP = Number(process.env.DEFHP ?? 1);
// PLAIN=1: the old fight (plain swings only). SPECIALS=0.5: both sides have half their day's specials and mana left.
const PLAIN = process.env.PLAIN === "1";
const SPECIALS = Number(process.env.SPECIALS ?? 1);
const snaps: Record<string, Snap[]> = {};
for (const c of CLASSES) for (const s of JSON.parse(readFileSync(`${prefix}${c}.json`, "utf8")) as Snap[]) (snaps[`${c}:${s.level}`] ??= []).push(s);

const pick = (c: Cls, l: number) => { const a = snaps[`${c}:${l}`]; return a?.[Math.floor(Math.random() * a.length)]; };
const asPlayer = (s: Snap, name: string, hpShare = 1) => ({ ...s, name, hp: Math.max(1, Math.round(s.max_hp * hpShare)) } as unknown as Player);

/** Share of fights the attacker wins, loses, draws. */
function duel(a: Cls, al: number, d: Cls, dl: number) {
  let w = 0, l = 0, dr = 0, rounds = 0;
  for (let i = 0; i < N; i++) {
    const as = pick(a, al), ds = pick(d, dl);
    if (!as || !ds) return null;
    const ap = asPlayer(as, "A"), dp = asPlayer(ds, "D", DEFHP);
    const kit = (p: Player) => ({ p, specials: GAME.classes[p.class].specialsPerDay * SPECIALS, mana: Math.round(manaMax(p) * SPECIALS) });
    const r = PLAIN ? resolveFull(playerAsFighter(ap), playerAsFighter(dp)) : resolveDuel(kit(ap), kit(dp));
    rounds += r.log.filter((e) => e.attacker === "A").length;
    if (r.winner === "attacker") w++; else if (r.winner === "defender") l++; else dr++;
  }
  return { w: w / N, l: l / N, d: dr / N, rounds: rounds / N };
}
const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);

console.log(`PvP: ${N} fights per cell${DEFHP < 1 ? `, defender starts at ${pct(DEFHP).trim()} HP` : ""}. Numbers are the attacker's win rate.\n`);

// 1. Same level, every pairing, averaged over levels 3..11
const LEVELS = [3, 4, 5, 6, 7, 8, 9, 10, 11];
console.log("Same level (avg of levels 3-11). Row attacks column:");
console.log("            " + CLASSES.map((c) => c.padStart(8)).join(""));
for (const a of CLASSES) {
  const cells = CLASSES.map((d) => { const rs = LEVELS.map((l) => duel(a, l, d, l)).filter(Boolean) as NonNullable<ReturnType<typeof duel>>[]; return rs.reduce((s, r) => s + r.w, 0) / rs.length; });
  console.log(a.padEnd(12) + cells.map((x) => pct(x).padStart(8)).join(""));
}

// 2. Each class as attacker against the field, by level
console.log("\nAttacker's win rate vs a random class at the same level:");
console.log("        " + LEVELS.map((l) => `L${l}`.padStart(5)).join(""));
for (const a of CLASSES) {
  const row = LEVELS.map((l) => { const rs = CLASSES.map((d) => duel(a, l, d, l)!); return rs.reduce((s, r) => s + r.w, 0) / rs.length; });
  console.log(a.padEnd(8) + row.map((x) => pct(x).padStart(5)).join(""));
}

// 3. Level gaps (the game allows up to 3)
console.log("\nLevel gap (attacker level minus defender level), all classes mixed, levels 4-10:");
for (const gap of [-3, -2, -1, 0, 1, 2, 3]) {
  let s = 0, n = 0;
  for (const l of [4, 5, 6, 7, 8, 9, 10]) for (const a of CLASSES) for (const d of CLASSES) { const r = duel(a, l + gap, d, l); if (r) { s += r.w; n++; } }
  console.log(`  ${gap > 0 ? "+" : ""}${gap}: ${pct(s / n)}`);
}

// 4. Fight length and draws
let dr = 0, rd = 0, n = 0;
for (const l of LEVELS) for (const a of CLASSES) for (const d of CLASSES) { const r = duel(a, l, d, l)!; dr += r.d; rd += r.rounds; n++; }
console.log(`\nAverage fight: ${(rd / n).toFixed(1)} exchanges; draws (50 exchanges, nobody down): ${pct(dr / n).trim()}`);
console.log(`Crit chance by class: ${CLASSES.map((c) => `${c} ${((GAME.classes[c] as { critChance?: number }).critChance ?? 0) * 100}%`).join(", ")}`);
