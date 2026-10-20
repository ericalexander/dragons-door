import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the player's API key lives. Nothing else is stored client-side. */
const env = (k: string) => process.env[`DRAGONS_DOOR_${k}`] ?? process.env[`LORD_${k}`];
export const CONFIG_DIR = env("CONFIG_DIR") ?? join(homedir(), ".config", "dragons-door");
/** Where the plugin kept its key before the rename to Dragon's Door. Read once and copied over. */
const LEGACY_DIR = join(homedir(), ".config", "lord");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export const DEFAULT_API_URL = "https://lord-ebon.vercel.app";

export interface Config {
  /** Resolved at load time: DRAGONS_DOOR_API_URL env, else an explicit `api_url` in the file, else the hosted realm. */
  api_url: string;
  api_key?: string;
  name?: string;
}

interface StoredConfig {
  api_key?: string;
  name?: string;
  /** Only present if the player put it there by hand to point at a different realm. Never written by us. */
  api_url?: string;
}

export async function loadConfig(): Promise<Config> {
  let stored: StoredConfig = {};
  try {
    stored = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as StoredConfig;
  } catch {
    // First run after the rename: carry the character over from the old folder.
    try {
      stored = JSON.parse(await readFile(join(LEGACY_DIR, "config.json"), "utf8")) as StoredConfig;
      if (stored.api_key) { await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 }); await writeFile(CONFIG_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 }); }
    } catch { /* no config yet */ }
  }
  return {
    api_url: env("API_URL") ?? stored.api_url ?? DEFAULT_API_URL,
    api_key: stored.api_key,
    name: stored.name,
  };
}

/** Persists only the character identity. The realm URL is not remembered unless the player wrote it themselves. */
export async function saveConfig(cfg: Config): Promise<void> {
  let stored: StoredConfig = {};
  try {
    stored = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as StoredConfig;
  } catch {
    /* fresh file */
  }
  const next: StoredConfig = { ...stored, api_key: cfg.api_key, name: cfg.name };
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
}
