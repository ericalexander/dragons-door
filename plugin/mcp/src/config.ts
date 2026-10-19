import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the player's API key lives. Nothing else is stored client-side. */
export const CONFIG_DIR = process.env.LORD_CONFIG_DIR ?? join(homedir(), ".config", "lord");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface Config {
  api_url: string;
  api_key?: string;
  name?: string;
}

export async function loadConfig(): Promise<Config> {
  const fallback: Config = { api_url: process.env.LORD_API_URL ?? "http://localhost:8787" };
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as Partial<Config>;
    return { ...fallback, ...raw, api_url: process.env.LORD_API_URL ?? raw.api_url ?? fallback.api_url };
  } catch {
    return fallback;
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
