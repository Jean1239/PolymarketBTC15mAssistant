import path from "path";
import { fileURLToPath } from "url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, getPool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "..", "..", "drizzle");

export async function runMigrations() {
  const db = getDb();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runMigrations();
    console.log("Migrations applied");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    await getPool().end();
  }
}
