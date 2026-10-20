/**
 * Which version of the plugin is running, and whether a newer one is out.
 * "Latest" is the plugin.json on main of the public repo — the same file /plugin update installs from.
 * Checked at most every 6 hours, cached on disk, and never allowed to slow the game down.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "./config.js";

const LATEST_URL = process.env.DRAGONS_DOOR_LATEST_URL ?? "https://raw.githubusercontent.com/ericalexander/dragons-door/main/plugin/.claude-plugin/plugin.json";
const CACHE = join(CONFIG_DIR, "latest-version");
const MAX_AGE = 6 * 3600;

// dist/index.js lives at <plugin>/mcp/dist/, the manifest at <plugin>/.claude-plugin/
export const VERSION: string = (() => {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".claude-plugin", "plugin.json"), "utf8")).version; }
  catch { return "0.0.0"; }
})();

const parts = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
export function newer(a: string, b: string) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

async function latest(): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  let cached: string | null = null;
  try {
    const [ts, v] = (await readFile(CACHE, "utf8")).trim().split(" ");
    cached = v || null;
    if (now - Number(ts) < MAX_AGE) return cached;
  } catch { /* no cache */ }
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(LATEST_URL, { signal: ac.signal });
    clearTimeout(t);
    const v = r.ok ? ((await r.json()) as { version?: string }).version : undefined;
    if (v && /^\d+\.\d+\.\d+$/.test(v)) {
      await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
      await writeFile(CACHE, `${now} ${v}\n`);
      return v;
    }
  } catch { /* offline, slow, or GitHub down: fall back to what we knew */ }
  return cached;
}

type Change = { version: string; lore: string; plain: string };
const CHANGES: Change[] = (() => {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "changelog.json"), "utf8")); }
  catch { return []; }
})();
const SEEN = join(CONFIG_DIR, "last-version");

/**
 * What changed since the version this player last entered with, oldest first, at most three.
 * Shown once: the file is advanced as soon as we report it. A brand-new player sees nothing;
 * a player from before this file existed sees only the newest entry.
 */
async function whatsNew(registered: boolean): Promise<Change[]> {
  let seen: string | null = null;
  try { seen = (await readFile(SEEN, "utf8")).trim() || null; } catch { /* first time */ }
  if (seen === VERSION) return [];
  let out: Change[] = [];
  if (seen) out = CHANGES.filter((c) => newer(c.version, seen!) && !newer(c.version, VERSION));
  else if (registered) out = CHANGES.filter((c) => !newer(c.version, VERSION)).slice(0, 1);
  try { await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 }); await writeFile(SEEN, VERSION + "\n"); } catch { /* best effort */ }
  return out.slice(0, 3).reverse();
}

export async function clientInfo(registered: boolean) {
  const [l, whats_new] = await Promise.all([latest(), whatsNew(registered)]);
  return { version: VERSION, latest: l, update_available: Boolean(l && newer(l, VERSION)), whats_new };
}
