import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import path from "path";
import fs from "fs";

const DB_PATH = path.join(process.cwd(), "data", "app.db");

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getDb() {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  _db = drizzle(sqlite, { schema });

  // Create tables inline (no migration files needed for MVP)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      read_status TEXT NOT NULL DEFAULT 'read' CHECK(read_status IN ('read','reading','want')),
      notes TEXT,
      analyze_status TEXT NOT NULL DEFAULT 'pending' CHECK(analyze_status IN ('pending','analyzing','done','error')),
      analyze_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS concepts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      aliases TEXT NOT NULL DEFAULT '[]',
      description TEXT,
      domain TEXT NOT NULL DEFAULT 'general',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS book_concepts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      importance INTEGER NOT NULL DEFAULT 3,
      excerpt TEXT
    );

    CREATE TABLE IF NOT EXISTS concept_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      to_concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL DEFAULT 'related'
        CHECK(relation_type IN ('prerequisite','related','contradicts','extends','applies_to')),
      weight REAL NOT NULL DEFAULT 1.0,
      source TEXT NOT NULL DEFAULT 'llm' CHECK(source IN ('llm','manual')),
      evidence TEXT,
      book_id INTEGER REFERENCES books(id) ON DELETE SET NULL
    );
  `);

  return _db;
}

export { getDb };
export type Db = ReturnType<typeof getDb>;
