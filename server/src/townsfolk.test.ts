import { test } from "node:test";
import assert from "node:assert/strict";
import { ROSTER } from "./townsfolk.js";
import { PLAN } from "./schedule.js";
import { reservedName } from "./api.js";

test("every townsperson has a known kind of habits, a voice and a unique name", () => {
  const seen = new Set<string>();
  for (const t of ROSTER) {
    assert.ok(PLAN[t.habits], `${t.name}: no timetable for ${t.habits}`);
    assert.ok(t.persona.length > 20 && t.away.length > 0, `${t.name}: needs a persona and away lines`);
    assert.ok(!seen.has(t.name.toLowerCase()), `${t.name} twice`);
    seen.add(t.name.toLowerCase());
    if (t.newcomer) assert.equal(t.level, undefined, `${t.name}: newcomers start at level 1`);
  }
});

test("newcomers' and new locals' names are reserved from players", () => {
  for (const t of ROSTER.filter((x) => x.newcomer || ["Rufus Kell", "Mirela Sorn", "Lew Tanner", "Sister Junia", "Sister Orla", "Bess Tolley", "Ione Vash", "Jem Arkwright"].includes(x.name)))
    assert.ok(reservedName(t.name), `${t.name} isn't reserved`);
});
