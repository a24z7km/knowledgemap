import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "path";
import fs from "fs";
import { RELATION_TYPES } from "@/lib/relations";
import {
  CONCEPT_LEVELS,
  CONCEPT_STATUSES,
  CONCEPT_TYPES,
  EXTRACTION_CATEGORIES,
  GROUNDING_TYPES,
  SPECIFICITY_LEVELS,
} from "@/lib/concept-metadata";

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
      user_toc TEXT,
      user_summary TEXT,
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
      grounding_type TEXT NOT NULL DEFAULT 'source_explicit' CHECK(grounding_type IN (${groundingTypeSqlList()})),
      category TEXT NOT NULL DEFAULT 'context' CHECK(category IN (${extractionCategorySqlList()})),
      final_score REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'promoted' CHECK(status IN (${conceptStatusSqlList()})),
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

    CREATE TABLE IF NOT EXISTS extraction_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled')),
      toc_count INTEGER NOT NULL DEFAULT 0,
      raw_count INTEGER NOT NULL DEFAULT 0,
      clustered_count INTEGER NOT NULL DEFAULT 0,
      promoted_count INTEGER NOT NULL DEFAULT 0,
      dropped_reasons TEXT NOT NULL DEFAULT '[]',
      source_stats TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS raw_concepts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      extraction_run_id INTEGER REFERENCES extraction_runs(id) ON DELETE CASCADE,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      raw_index INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      name_ja TEXT,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'context' CHECK(category IN (${extractionCategorySqlList()})),
      grounding_type TEXT NOT NULL DEFAULT 'source_explicit' CHECK(grounding_type IN (${groundingTypeSqlList()})),
      evidence_text TEXT,
      importance INTEGER NOT NULL DEFAULT 3,
      specificity INTEGER NOT NULL DEFAULT 3,
      confidence REAL NOT NULL DEFAULT 0.5,
      source_type TEXT,
      source_text TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  ensureRelationTypeConstraint(sqlite);
  ensureAnalyzeStatusConstraint(sqlite);
  ensureBookUserSourceColumns(sqlite);
  ensureConceptScoringColumns(sqlite);
  ensureGroundingTypeConstraints(sqlite);
  ensureBookConceptMetadataColumns(sqlite);
  ensureBookConceptSourceEvidenceColumns(sqlite);
  normalizeExistingConceptRelations(sqlite);
  ensureConceptRelationUniqueIndexes(sqlite);
  ensureExtractionRunIndexes(sqlite);
  ensureRawConceptIndexes(sqlite);
  ensureBookStep1Columns(sqlite);
  ensureBookKeywordDraftsTable(sqlite);

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

function extractionCategorySqlList() {
  return EXTRACTION_CATEGORIES.map((category) => `'${category}'`).join(",");
}

function groundingTypeSqlList() {
  return GROUNDING_TYPES.map((groundingType) => `'${groundingType}'`).join(",");
}

function conceptStatusSqlList() {
  return CONCEPT_STATUSES.map((status) => `'${status}'`).join(",");
}

function ensureBookUserSourceColumns(sqlite: Database.Database) {
  const columns = sqlite.prepare("PRAGMA table_info(books)").all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("user_toc")) {
    sqlite.exec("ALTER TABLE books ADD COLUMN user_toc TEXT");
  }
  if (!columnNames.has("user_summary")) {
    sqlite.exec("ALTER TABLE books ADD COLUMN user_summary TEXT");
  }
}

function groundingTypeSelectExpression(column = "grounding_type") {
  return `CASE
    WHEN ${column} = 'source_implied' THEN 'source_supported'
    WHEN ${column} = 'known_book' THEN 'model_prior'
    WHEN ${column} IN (${groundingTypeSqlList()}) THEN ${column}
    ELSE 'model_prior'
  END`;
}

function ensureGroundingTypeConstraints(sqlite: Database.Database) {
  const conceptTable = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'concepts'")
    .get() as { sql?: string } | undefined;
  const rawConceptTable = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'raw_concepts'")
    .get() as { sql?: string } | undefined;

  const conceptNeedsMigration = conceptTable?.sql?.includes("source_implied") || conceptTable?.sql?.includes("known_book");
  const rawConceptNeedsMigration = rawConceptTable?.sql?.includes("source_implied") || rawConceptTable?.sql?.includes("known_book");

  if (!conceptNeedsMigration && !rawConceptNeedsMigration) return;

  sqlite.exec("PRAGMA foreign_keys = OFF");
  const migrateGroundingTypes = sqlite.transaction(() => {
    if (conceptNeedsMigration) {
      sqlite.exec(`
        CREATE TABLE concepts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          aliases TEXT NOT NULL DEFAULT '[]',
          description TEXT,
          domain TEXT NOT NULL DEFAULT 'general',
          grounding_type TEXT NOT NULL DEFAULT 'source_explicit' CHECK(grounding_type IN (${groundingTypeSqlList()})),
          category TEXT NOT NULL DEFAULT 'context' CHECK(category IN (${extractionCategorySqlList()})),
          final_score REAL NOT NULL DEFAULT 1.0,
          status TEXT NOT NULL DEFAULT 'promoted' CHECK(status IN (${conceptStatusSqlList()})),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO concepts_new (
          id, name, aliases, description, domain, grounding_type, category, final_score, status, created_at
        )
        SELECT
          id,
          name,
          aliases,
          description,
          domain,
          ${groundingTypeSelectExpression()},
          category,
          final_score,
          status,
          created_at
        FROM concepts;

        DROP TABLE concepts;
        ALTER TABLE concepts_new RENAME TO concepts;
      `);
    }

    if (rawConceptNeedsMigration) {
      sqlite.exec(`
        CREATE TABLE raw_concepts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          extraction_run_id INTEGER REFERENCES extraction_runs(id) ON DELETE CASCADE,
          book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          raw_index INTEGER NOT NULL DEFAULT 0,
          name TEXT NOT NULL,
          name_ja TEXT,
          description TEXT,
          category TEXT NOT NULL DEFAULT 'context' CHECK(category IN (${extractionCategorySqlList()})),
          grounding_type TEXT NOT NULL DEFAULT 'source_explicit' CHECK(grounding_type IN (${groundingTypeSqlList()})),
          evidence_text TEXT,
          importance INTEGER NOT NULL DEFAULT 3,
          specificity INTEGER NOT NULL DEFAULT 3,
          confidence REAL NOT NULL DEFAULT 0.5,
          source_type TEXT,
          source_text TEXT,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO raw_concepts_new (
          id, extraction_run_id, book_id, raw_index, name, name_ja, description, category,
          grounding_type, evidence_text, importance, specificity, confidence, source_type, source_text,
          payload, created_at
        )
        SELECT
          id,
          extraction_run_id,
          book_id,
          raw_index,
          name,
          name_ja,
          description,
          category,
          ${groundingTypeSelectExpression()},
          evidence_text,
          importance,
          specificity,
          confidence,
          source_type,
          source_text,
          payload,
          created_at
        FROM raw_concepts;

        DROP TABLE raw_concepts;
        ALTER TABLE raw_concepts_new RENAME TO raw_concepts;
      `);
    }
  });

  try {
    migrateGroundingTypes();
  } finally {
    sqlite.exec("PRAGMA foreign_keys = ON");
  }
}

function ensureConceptScoringColumns(sqlite: Database.Database) {
  const columns = sqlite.prepare("PRAGMA table_info(concepts)").all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("grounding_type")) {
    sqlite.exec(`
      ALTER TABLE concepts
      ADD COLUMN grounding_type TEXT NOT NULL DEFAULT 'source_explicit'
      CHECK(grounding_type IN (${groundingTypeSqlList()}))
    `);
  }

  if (!columnNames.has("category")) {
    sqlite.exec(`
      ALTER TABLE concepts
      ADD COLUMN category TEXT NOT NULL DEFAULT 'context'
      CHECK(category IN (${extractionCategorySqlList()}))
    `);
  }

  if (!columnNames.has("final_score")) {
    sqlite.exec("ALTER TABLE concepts ADD COLUMN final_score REAL NOT NULL DEFAULT 1.0");
  }

  if (!columnNames.has("status")) {
    sqlite.exec(`
      ALTER TABLE concepts
      ADD COLUMN status TEXT NOT NULL DEFAULT 'promoted'
      CHECK(status IN (${conceptStatusSqlList()}))
    `);
  }
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
        user_toc TEXT,
        user_summary TEXT,
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
        user_toc,
        user_summary,
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
        NULL,
        NULL,
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

function ensureExtractionRunIndexes(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_extraction_runs_book_created
    ON extraction_runs (book_id, created_at DESC);
  `);
}

function ensureRawConceptIndexes(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_raw_concepts_book
    ON raw_concepts (book_id);

    CREATE INDEX IF NOT EXISTS idx_raw_concepts_extraction_run
    ON raw_concepts (extraction_run_id);
  `);
}

function ensureBookStep1Columns(sqlite: Database.Database) {
  const columns = sqlite.prepare("PRAGMA table_info(books)").all() as { name: string }[];
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("user_keywords")) {
    sqlite.exec("ALTER TABLE books ADD COLUMN user_keywords TEXT");
  }
  if (!columnNames.has("user_quotes")) {
    sqlite.exec("ALTER TABLE books ADD COLUMN user_quotes TEXT");
  }
  if (!columnNames.has("step1_completed_at")) {
    sqlite.exec("ALTER TABLE books ADD COLUMN step1_completed_at TEXT");
  }
  if (!columnNames.has("step1_model")) {
    sqlite.exec("ALTER TABLE books ADD COLUMN step1_model TEXT");
  }
}

function ensureBookKeywordDraftsTable(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS book_keyword_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK(source IN ('web_search','book_db','user_input','user_toc','user_summary')),
      text TEXT NOT NULL,
      source_url TEXT,
      evidence_text TEXT,
      deleted_by_user INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_book_keyword_drafts_book
    ON book_keyword_drafts (book_id);
  `);
}

export { getDb };
export type Db = ReturnType<typeof getDb>;
