import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "path";
import fs from "fs";
import { RELATION_TYPES } from "@/lib/relations";
import { CONCEPT_LEVELS, CONCEPT_TYPES, SPECIFICITY_LEVELS } from "@/lib/concept-metadata";

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
      analyze_status TEXT NOT NULL DEFAULT 'pending' CHECK(analyze_status IN (${analyzeStatusSqlList()})),
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
      excerpt TEXT,
      concept_level TEXT NOT NULL DEFAULT 'supporting' CHECK(concept_level IN (${conceptLevelSqlList()})),
      concept_type TEXT NOT NULL DEFAULT 'theme' CHECK(concept_type IN (${conceptTypeSqlList()})),
      specificity TEXT NOT NULL DEFAULT 'domain_specific' CHECK(specificity IN (${specificitySqlList()}))
    );

    CREATE TABLE IF NOT EXISTS concept_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      to_concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL DEFAULT 'related'
        CHECK(relation_type IN (${relationTypeSqlList()})),
      weight REAL NOT NULL DEFAULT 1.0,
      source TEXT NOT NULL DEFAULT 'llm' CHECK(source IN ('llm','manual')),
      evidence TEXT,
      book_id INTEGER REFERENCES books(id) ON DELETE SET NULL
    );
  `);

  ensureRelationTypeConstraint(sqlite);
  ensureAnalyzeStatusConstraint(sqlite);
  ensureBookConceptMetadataColumns(sqlite);
  ensureBookConceptSourceEvidenceColumns(sqlite);
  normalizeExistingConceptRelations(sqlite);
  ensureConceptRelationUniqueIndexes(sqlite);

  return _db;
}

function analyzeStatusSqlList() {
  return "'pending','analyzing','done','error','failed'";
}

function relationTypeSqlList() {
  return RELATION_TYPES.map((type) => `'${type}'`).join(",");
}

function conceptLevelSqlList() {
  return CONCEPT_LEVELS.map((level) => `'${level}'`).join(",");
}

function conceptTypeSqlList() {
  return CONCEPT_TYPES.map((type) => `'${type}'`).join(",");
}

function specificitySqlList() {
  return SPECIFICITY_LEVELS.map((specificity) => `'${specificity}'`).join(",");
}

function ensureBookConceptMetadataColumns(sqlite: Database.Database) {
  const columns = sqlite.prepare("PRAGMA table_info(book_concepts)").all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("concept_level")) {
    sqlite.exec(`
      ALTER TABLE book_concepts
      ADD COLUMN concept_level TEXT NOT NULL DEFAULT 'supporting'
      CHECK(concept_level IN (${conceptLevelSqlList()}))
    `);
  }

  if (!columnNames.has("concept_type")) {
    sqlite.exec(`
      ALTER TABLE book_concepts
      ADD COLUMN concept_type TEXT NOT NULL DEFAULT 'theme'
      CHECK(concept_type IN (${conceptTypeSqlList()}))
    `);
  }

  if (!columnNames.has("specificity")) {
    sqlite.exec(`
      ALTER TABLE book_concepts
      ADD COLUMN specificity TEXT NOT NULL DEFAULT 'domain_specific'
      CHECK(specificity IN (${specificitySqlList()}))
    `);
  }
}

function ensureBookConceptSourceEvidenceColumns(sqlite: Database.Database) {
  const columns = sqlite.prepare("PRAGMA table_info(book_concepts)").all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("source_evidence_type")) {
    sqlite.exec(`ALTER TABLE book_concepts ADD COLUMN source_evidence_type TEXT`);
  }
  if (!columnNames.has("source_evidence_text")) {
    sqlite.exec(`ALTER TABLE book_concepts ADD COLUMN source_evidence_text TEXT`);
  }
}

function ensureAnalyzeStatusConstraint(sqlite: Database.Database) {
  const table = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'books'")
    .get() as { sql?: string } | undefined;

  if (table?.sql?.includes("'failed'")) return;

  sqlite.exec("PRAGMA foreign_keys = OFF");
  const migrateAnalyzeStatuses = sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE books_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        read_status TEXT NOT NULL DEFAULT 'read' CHECK(read_status IN ('read','reading','want')),
        notes TEXT,
        analyze_status TEXT NOT NULL DEFAULT 'pending' CHECK(analyze_status IN (${analyzeStatusSqlList()})),
        analyze_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO books_new (
        id,
        title,
        author,
        read_status,
        notes,
        analyze_status,
        analyze_error,
        created_at
      )
      SELECT
        id,
        title,
        author,
        read_status,
        notes,
        CASE
          WHEN analyze_status IN (${analyzeStatusSqlList()}) THEN analyze_status
          ELSE 'failed'
        END,
        analyze_error,
        created_at
      FROM books;

      DROP TABLE books;
      ALTER TABLE books_new RENAME TO books;
    `);
  });

  try {
    migrateAnalyzeStatuses();
  } finally {
    sqlite.exec("PRAGMA foreign_keys = ON");
  }
}

function ensureRelationTypeConstraint(sqlite: Database.Database) {
  const table = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'concept_relations'")
    .get() as { sql?: string } | undefined;

  if (table?.sql?.includes("same_family_as")) return;

  sqlite.exec("PRAGMA foreign_keys = OFF");
  const migrateRelationTypes = sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE concept_relations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        to_concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL DEFAULT 'related'
          CHECK(relation_type IN (${relationTypeSqlList()})),
        weight REAL NOT NULL DEFAULT 1.0,
        source TEXT NOT NULL DEFAULT 'llm' CHECK(source IN ('llm','manual')),
        evidence TEXT,
        book_id INTEGER REFERENCES books(id) ON DELETE SET NULL
      );

      INSERT INTO concept_relations_new (
        id,
        from_concept_id,
        to_concept_id,
        relation_type,
        weight,
        source,
        evidence,
        book_id
      )
      SELECT
        id,
        from_concept_id,
        to_concept_id,
        CASE
          WHEN relation_type IN (${relationTypeSqlList()}) THEN relation_type
          ELSE 'related'
        END,
        weight,
        source,
        evidence,
        book_id
      FROM concept_relations;

      DROP TABLE concept_relations;
      ALTER TABLE concept_relations_new RENAME TO concept_relations;
    `);
  });

  try {
    migrateRelationTypes();
  } finally {
    sqlite.exec("PRAGMA foreign_keys = ON");
  }
}

function normalizeExistingConceptRelations(sqlite: Database.Database) {
  const rows = sqlite
    .prepare("SELECT id, from_concept_id, to_concept_id, relation_type, book_id FROM concept_relations ORDER BY id")
    .all() as {
      id: number;
      from_concept_id: number;
      to_concept_id: number;
      relation_type: string;
      book_id: number | null;
    }[];
  const seen = new Set<string>();

  const normalizeRelation = sqlite.transaction(() => {
    for (const row of rows) {
      const isUndirected = ["related", "same_family_as", "contrasts_with"].includes(row.relation_type);
      const fromConceptId = isUndirected ? Math.min(row.from_concept_id, row.to_concept_id) : row.from_concept_id;
      const toConceptId = isUndirected ? Math.max(row.from_concept_id, row.to_concept_id) : row.to_concept_id;
      const scope = row.book_id == null ? "cross_book" : String(row.book_id);
      const key = `${fromConceptId}||${toConceptId}||${row.relation_type}||${scope}`;

      if (seen.has(key)) {
        sqlite.prepare("DELETE FROM concept_relations WHERE id = ?").run(row.id);
        continue;
      }

      seen.add(key);
      if (fromConceptId !== row.from_concept_id || toConceptId !== row.to_concept_id) {
        sqlite
          .prepare("UPDATE concept_relations SET from_concept_id = ?, to_concept_id = ? WHERE id = ?")
          .run(fromConceptId, toConceptId, row.id);
      }
    }
  });

  normalizeRelation();
}

function ensureConceptRelationUniqueIndexes(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_concept_relations_unique_book
    ON concept_relations (from_concept_id, to_concept_id, relation_type, book_id)
    WHERE book_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_concept_relations_unique_cross_book
    ON concept_relations (from_concept_id, to_concept_id, relation_type)
    WHERE book_id IS NULL;
  `);
}

export { getDb };
export type Db = ReturnType<typeof getDb>;
