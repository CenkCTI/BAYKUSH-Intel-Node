import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const migrationsDir = path.resolve(process.cwd(), "db/migrations");

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS node_schema_migrations (
      filename text PRIMARY KEY,
      sha256 char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const filename of files) {
    const sql = await readFile(path.join(migrationsDir, filename), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    const existing = await pool.query(
      "SELECT sha256 FROM node_schema_migrations WHERE filename = $1",
      [filename],
    );

    if (existing.rowCount) {
      if (existing.rows[0].sha256 !== sha256) {
        throw new Error(`Applied migration changed: ${filename}`);
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO node_schema_migrations(filename, sha256) VALUES ($1, $2)",
        [filename, sha256],
      );
      await client.query("COMMIT");
      console.log(`applied ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
