import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { RELATION_TYPES } from "@/lib/relations";

export const books = sqliteTable("books", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  author: text("author").notNull(),
  readStatus: text("read_status", { enum: ["read", "reading", "want"] }).notNull().default("read"),
  notes: text("notes"),
  analyzeStatus: text("analyze_status", { enum: ["pending", "analyzing", "done", "error", "failed"] }).notNull().default("pending"),
  analyzeError: text("analyze_error"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const concepts = sqliteTable("concepts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  aliases: text("aliases").notNull().default("[]"),
  description: text("description"),
  domain: text("domain").notNull().default("general"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const bookConcepts = sqliteTable("book_concepts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bookId: integer("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  conceptId: integer("concept_id").notNull().references(() => concepts.id, { onDelete: "cascade" }),
  importance: integer("importance").notNull().default(3),
  excerpt: text("excerpt"),
});

export const conceptRelations = sqliteTable("concept_relations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fromConceptId: integer("from_concept_id").notNull().references(() => concepts.id, { onDelete: "cascade" }),
  toConceptId: integer("to_concept_id").notNull().references(() => concepts.id, { onDelete: "cascade" }),
  relationType: text("relation_type", {
    enum: RELATION_TYPES,
  }).notNull().default("related"),
  weight: real("weight").notNull().default(1.0),
  source: text("source", { enum: ["llm", "manual"] }).notNull().default("llm"),
  evidence: text("evidence"),
  bookId: integer("book_id").references(() => books.id, { onDelete: "set null" }),
});

export type Book = typeof books.$inferSelect;
export type NewBook = typeof books.$inferInsert;
export type Concept = typeof concepts.$inferSelect;
export type NewConcept = typeof concepts.$inferInsert;
export type BookConcept = typeof bookConcepts.$inferSelect;
export type ConceptRelation = typeof conceptRelations.$inferSelect;
