import path from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.resolve(__dirname, "..", "..", "logs", "auth.db");

let sqlite;
let dbInstance;

export function getDatabasePath() {
  return process.env.SQLITE_PATH ?? DEFAULT_PATH;
}

export function getSqlite() {
  if (!sqlite) {
    const file = getDatabasePath();
    mkdirSync(path.dirname(file), { recursive: true });
    sqlite = new Database(file);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
  }
  return sqlite;
}

export function getDb() {
  if (!dbInstance) {
    dbInstance = drizzle(getSqlite(), { schema });
  }
  return dbInstance;
}

export function closeDb() {
  if (sqlite) {
    sqlite.close();
    sqlite = undefined;
    dbInstance = undefined;
  }
}

export { schema };
