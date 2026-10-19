import pg from "pg";
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Read server/.env (and repo-root .env) if present. Real env vars win.
for (const dir of [join(dirname(fileURLToPath(import.meta.url)), ".."), join(dirname(fileURLToPath(import.meta.url)), "..", "..")]) {
  const f = join(dir, ".env");
  if (existsSync(f)) { try { loadEnvFile(f); } catch { /* ignore */ } }
}

const { Pool } = pg;

const url = process.env.DATABASE_URL ?? "postgres://lord:lord@localhost:5433/lord";
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

export const pool = new Pool({
  connectionString: url,
  // Hosted Postgres (Supabase etc.) requires TLS; local docker does not.
  ssl: local ? false : { rejectUnauthorized: false },
  // Serverless: many short-lived instances, so keep each pool tiny.
  max: process.env.VERCEL ? 2 : 10,
  idleTimeoutMillis: 10_000,
});

export type Client = pg.PoolClient;

/** Run fn inside a transaction. Rolls back on throw. */
export async function tx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
