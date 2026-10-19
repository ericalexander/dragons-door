import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function main() {
  await pool.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())`);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await pool.query("select 1 from schema_migrations where name = $1", [f]);
    if (done.rowCount) continue;
    const sql = await readFile(join(dir, f), "utf8");
    await pool.query("begin");
    try {
      await pool.query(sql);
      await pool.query("insert into schema_migrations (name) values ($1)", [f]);
      await pool.query("commit");
      console.log("applied", f);
    } catch (e) {
      await pool.query("rollback");
      throw e;
    }
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
