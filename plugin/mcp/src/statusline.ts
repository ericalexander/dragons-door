/**
 * Installs (or removes) the Dragon's Door news and mail indicators in the user's Claude Code status line.
 * Plugins can't set statusLine themselves, so this runs only when the player asks.
 * It wraps whatever status line they already have, and saves it so uninstall restores it exactly.
 */
import { chmod, copyFile, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "./config.js";

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const SETTINGS = join(CLAUDE_DIR, "settings.json");
const SCRIPT_DEST = join(CLAUDE_DIR, "dragons-door-statusline.sh");
const PREV = join(CLAUDE_DIR, "dragons-door-statusline.prev");
const ORIG = join(CLAUDE_DIR, "dragons-door-statusline.orig.json");
// The same files from before the rename (Dragonmoor). Recognized and moved over, so nothing is lost.
const LEGACY = { script: join(CLAUDE_DIR, "dragonmoor-statusline.sh"), prev: join(CLAUDE_DIR, "dragonmoor-statusline.prev"), orig: join(CLAUDE_DIR, "dragonmoor-statusline.orig.json") };
const LEGACY_COMMAND = `bash "${LEGACY.script}"`;
const OUR_COMMAND = `bash "${SCRIPT_DEST}"`;

// dist/index.js lives at <plugin>/mcp/dist/, the script at <plugin>/statusline/
const SCRIPT_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "statusline", "dragons-door-statusline.sh");

async function exists(p: string) { try { await stat(p); return true; } catch { return false; } }
async function readJson(p: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(p, "utf8")); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`couldn't read ${p}: ${(e as Error).message}`);
  }
}

type StatusLine = { type?: string; command?: string; padding?: number; refreshInterval?: number; [k: string]: unknown };

/** If the pre-rename indicator is installed, move its saved files to the new names and point at the new script. */
async function migrateLegacy(settings: Record<string, unknown>): Promise<boolean> {
  const current = settings.statusLine as StatusLine | undefined;
  if (current?.command !== LEGACY_COMMAND) return false;
  for (const [from, to] of [[LEGACY.prev, PREV], [LEGACY.orig, ORIG]]) {
    try { await writeFile(to, await readFile(from, "utf8")); } catch { /* missing is fine */ }
  }
  settings.statusLine = { ...current, command: OUR_COMMAND };
  for (const f of Object.values(LEGACY)) await rm(f, { force: true });
  return true;
}

export async function installStatusline(cwd: string): Promise<Record<string, unknown>> {
  const settings = await readJson(SETTINGS);
  await migrateLegacy(settings);
  const current = settings.statusLine as StatusLine | undefined;
  const already = current?.command === OUR_COMMAND;
  await mkdir(CLAUDE_DIR, { recursive: true });

  if (!already) {
    // one-time backup of the whole settings file, then remember their status line
    const backup = `${SETTINGS}.dragons-door-backup`;
    if (await exists(SETTINGS) && !(await exists(backup))) await copyFile(SETTINGS, backup);
    await writeFile(ORIG, JSON.stringify(current ?? null, null, 2));
    await writeFile(PREV, current?.type === "command" && current.command ? current.command : "");
  }
  await copyFile(SCRIPT_SRC, SCRIPT_DEST);
  await chmod(SCRIPT_DEST, 0o755);
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });

  settings.statusLine = {
    ...(already ? current : (current ?? {})),
    type: "command",
    command: OUR_COMMAND,
    refreshInterval: current?.refreshInterval ?? 30,
  };
  await writeFile(SETTINGS, JSON.stringify(settings, null, 2) + "\n");

  const project = await readJson(join(cwd, ".claude", "settings.json")).catch(() => ({}));
  const projectLocal = await readJson(join(cwd, ".claude", "settings.local.json")).catch(() => ({}));
  const overridden = "statusLine" in project || "statusLine" in projectLocal;

  return {
    kind: "statusline_installed",
    settings: SETTINGS,
    kept_existing: Boolean(!already && current?.command),
    previous: already ? "(already installed)" : current?.command ?? null,
    refresh_seconds: (settings.statusLine as StatusLine).refreshInterval,
    project_overrides: overridden ? "This project's own .claude settings set a status line, which wins here; the envelope will show in other projects." : null,
    backup: `${SETTINGS}.dragons-door-backup`,
  };
}

export async function uninstallStatusline(): Promise<Record<string, unknown>> {
  const settings = await readJson(SETTINGS);
  await migrateLegacy(settings);
  const current = settings.statusLine as StatusLine | undefined;
  if (current?.command !== OUR_COMMAND) return { kind: "statusline_not_installed" };
  let orig: StatusLine | null = null;
  try { orig = JSON.parse(await readFile(ORIG, "utf8")); } catch { orig = null; }
  if (orig) settings.statusLine = orig; else delete settings.statusLine;
  await writeFile(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  for (const f of [SCRIPT_DEST, PREV, ORIG]) await rm(f, { force: true });
  return { kind: "statusline_removed", restored: orig?.command ?? null };
}

/** Keep the status line's cached counts (mail, news) current while playing, without waiting for its own refresh. */
export async function noteUnread(mail: number, news: number) {
  try { await writeFile(join(CONFIG_DIR, "statusline-unread"), `${Math.floor(Date.now() / 1000)} ${mail} ${news}\n`); } catch { /* best effort */ }
}

/** If the indicator is installed, keep its copied script in step with the plugin's, so updates reach it without reinstalling. */
export async function refreshInstalledScript() {
  try {
    const settings = await readJson(SETTINGS);
    if ((settings.statusLine as StatusLine | undefined)?.command !== OUR_COMMAND) return;
    const [want, have] = await Promise.all([readFile(SCRIPT_SRC, "utf8"), readFile(SCRIPT_DEST, "utf8").catch(() => "")]);
    if (want !== have) { await writeFile(SCRIPT_DEST, want); await chmod(SCRIPT_DEST, 0o755); }
  } catch { /* best effort */ }
}
