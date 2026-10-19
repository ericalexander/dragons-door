import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://lord:lord@localhost:5432/lord",
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
