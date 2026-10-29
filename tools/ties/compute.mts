import { readFileSync, writeFileSync } from "node:fs";
const { score, word } = await import("../../server/src/standing.ts");
const { QUESTS } = await import("../../server/src/quests.ts");
const { homeOf } = await import("../../server/src/towns.ts");
const dir = process.argv[2]; const R = JSON.parse(readFileSync(`${dir}/raw.json`, "utf8"));
const lore = JSON.parse(readFileSync(process.env.DRAGONS_DOOR_LORE ?? "/home/claude/lord-lore/lore.json", "utf8"));
const allQuests = [...QUESTS, ...(lore.quests ?? [])];
const questPeople = (id: string) => { const q = allQuests.find((x: any) => x.id === id); if (!q) return [];
  return [...new Set([...(q.start_on?.talk ?? []), ...q.steps.flatMap((s: any) => s.on && Array.isArray(s.on.talk) ? s.on.talk : [])])]; };
const days = (d: string) => Math.round((Date.parse(R.today) - Date.parse(d)) / 86400000);
const nodes: any[] = [];
for (const [n, c, l, t] of R.players) nodes.push({ id: n, kind: "player", cls: c, level: l, town: t });
for (const [n, c, l, t] of R.townsfolk) nodes.push({ id: n, kind: "townsfolk", cls: c, level: l, town: t });
const known = new Set(nodes.map((x) => x.id));
const links: any[] = [];
// Player -> character/townsperson: how they feel about the player.
const pairs = new Set<string>();
for (const [p, n] of [...R.talks, ...R.gifts, ...R.letters].map((r: any) => [r[0], r[1]])) pairs.add(`${p}|${n}`);
for (const [a, t] of R.robbed) if (R.players.some((x: any) => x[0] === a)) pairs.add(`${a}|${t}`);
for (const [p, q] of R.quests) for (const n of questPeople(q)) pairs.add(`${p}|${n}`);
for (const [p, , , , sp] of R.players) if (sp) pairs.add(`${p}|${sp}`);
for (const key of pairs) {
  const [p, n] = key.split("|");
  if (!R.players.some((x: any) => x[0] === p)) continue;
  if (R.players.some((x: any) => x[0] === n)) continue; // player-on-player isn't standing
  const t = R.talks.find((r: any) => r[0] === p && r[1] === n);
  const g = R.gifts.filter((r: any) => r[0] === p && r[1] === n);
  const le = R.letters.find((r: any) => r[0] === p && r[1] === n);
  const lasts = [t?.[3], ...g.map((x: any) => x[3]), le?.[3]].filter(Boolean).sort();
  const f = { talkDays: t?.[2] ?? 0, gifts: g.map((x: any) => x[2]), letterDays: le?.[2] ?? 0,
    quests: R.quests.filter((r: any) => r[0] === p && questPeople(r[1]).includes(n)).length,
    robbedDaysAgo: R.robbed.filter((r: any) => r[0] === p && r[1] === n).map((r: any) => r[2]),
    sinceContact: lasts.length ? days(lasts[lasts.length - 1]) : null, married: R.players.find((x: any) => x[0] === p)[4] === n };
  const pts = score(f);
  if (!known.has(n)) { nodes.push({ id: n, kind: "character", town: homeOf(n)?.id ?? "brightwater" }); known.add(n); }
  links.push({ source: n, target: p, kind: "standing", word: word(pts, f.talkDays > 0), points: Math.round(pts * 10) / 10,
    why: [f.talkDays && `${f.talkDays} day${f.talkDays > 1 ? "s" : ""} talking`, g.length && `${g.length} gift${g.length > 1 ? "s" : ""} kept`, f.letterDays && `letters on ${f.letterDays} day${f.letterDays > 1 ? "s" : ""}`, f.quests && "a quest together", f.robbedDaysAgo.length && `robbed ${f.robbedDaysAgo.length}x lately`, f.married && "married"].filter(Boolean).join(", ") });
}
// Townsfolk <-> townsfolk: each way.
const tf = new Set(R.townsfolk.map((x: any) => x[0]));
const bpairs = new Set<string>();
for (const [a, b] of R.bonds) bpairs.add([a, b].sort().join("|"));
for (const [a, t] of R.robbed) if (tf.has(a) && tf.has(t)) bpairs.add([a, t].sort().join("|"));
for (const key of bpairs) {
  const [a, b] = key.split("|");
  const row = R.bonds.find((r: any) => [r[0], r[1]].sort().join("|") === key);
  for (const [me, other] of [[a, b], [b, a]]) {
    const f = { talkDays: row?.[2] ?? 0, gifts: [], letterDays: 0, quests: 0, robbedDaysAgo: R.robbed.filter((r: any) => r[0] === other && r[1] === me).map((r: any) => r[2]),
      sinceContact: row?.[3] ? days(row[3]) : null, married: false };
    const pts = score(f);
    links.push({ source: me, target: other, kind: "bond", word: word(pts, f.talkDays > 0), points: Math.round(pts * 10) / 10,
      why: [f.talkDays && `${f.talkDays} evening${f.talkDays > 1 ? "s" : ""} together`, f.robbedDaysAgo.length && `robbed by ${other}`].filter(Boolean).join(", ") });
  }
}
writeFileSync(`${dir}/ties.json`, JSON.stringify({ day: R.today, nodes, links }));
console.log(nodes.length, "people,", links.length, "feelings");
for (const l of links.filter((l) => l.kind === "standing")) console.log(`${l.source} -> ${l.target}: ${l.word} (${l.points}) ${l.why}`);
console.log(links.filter((l) => l.kind === "bond").map((l) => `${l.source}->${l.target} ${l.word}`).join("; "));
