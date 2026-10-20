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

export async function clientInfo() {
  const l = await latest();
  return { version: VERSION, latest: l, update_available: Boolean(l && newer(l, VERSION)) };
}
