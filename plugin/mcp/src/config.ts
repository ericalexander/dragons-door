import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the player's API key lives. Nothing else is stored client-side. */
const env = (k: string) => process.env[`DRAGONS_DOOR_${k}`] ?? process.env[`LORD_${k}`];
export const CONFIG_DIR = env("CONFIG_DIR") ?? join(homedir(), ".config", "dragons-door");
/** Where the plugin kept its key before the rename to Dragon's Door. Read once and copied over. */
const LEGACY_DIR = join(homedir(), ".config", "lord");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export const DEFAULT_API_URL = "https://dragons-door-api.vercel.app";
/** Addresses early versions saved into config files. They redirect now, and a redirect drops the key, so ignore them. */
const RETIRED_URLS = [/^https?:\/\/lord-ebon\.vercel\.app\/?$/];
const usable = (u?: string) => (u && !RETIRED_URLS.some((r) => r.test(u)) ? u : undefined);

export interface Config {
  /** Resolved at load time: DRAGONS_DOOR_API_URL env, else an explicit `api_url` in the file, else the hosted realm. */
  api_url: string;
  api_key?: string;
  name?: string;
}

interface StoredConfig {
  api_key?: string;
  name?: string;
  /** Other characters on this machine, by name (a maintainer's test characters). The active one is api_key/name. */
  characters?: Record<string, string>;
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
      if (!usable(stored.api_url)) delete stored.api_url;
      if (stored.api_key) { await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 }); await writeFile(CONFIG_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 }); }
    } catch { /* no config yet */ }
  }
  return {
    api_url: env("API_URL") ?? usable(stored.api_url) ?? DEFAULT_API_URL,
    api_key: stored.api_key,
    name: stored.name,
  };
}

/** Persists only the character identity. The realm URL is not remembered unless the player wrote it themselves. */
/** The other characters kept on this machine, if any (names only). */
export async function otherCharacters(): Promise<string[]> {
  try { return Object.keys((JSON.parse(await readFile(CONFIG_FILE, "utf8")) as StoredConfig).characters ?? {}); } catch { return []; }
}

/**
 * Switch the active character. The current one is kept in the roster; `key` adds a new one.
 * Returns false if there's no such character.
 */
export async function switchCharacter(name: string, key?: string): Promise<boolean> {
  let stored: StoredConfig = {};
  try { stored = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as StoredConfig; } catch { /* fresh */ }
  const roster = { ...(stored.characters ?? {}) };
  if (stored.api_key && stored.name) roster[stored.name] = stored.api_key;
  const match = Object.keys(roster).find((n) => n.toLowerCase() === name.toLowerCase());
  const nextKey = key ?? (match ? roster[match] : undefined);
  if (!nextKey) return false;
  const nextName = key ? name : match!;
  delete roster[nextName];
  const next: StoredConfig = { ...stored, api_key: nextKey, name: nextName, characters: roster };
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return true;
}

export async function saveConfig(cfg: Config): Promise<void> {
  let stored: StoredConfig = {};
  try {
    stored = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as StoredConfig;
  } catch {
    /* fresh file */
  }
  const next: StoredConfig = { ...stored, api_key: cfg.api_key, name: cfg.name };
  if (!usable(next.api_url)) delete next.api_url;
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
}
