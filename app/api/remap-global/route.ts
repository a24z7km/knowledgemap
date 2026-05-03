import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, concepts, bookConcepts, conceptRelations } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { parseAliases } from "@/lib/concepts/normalize";
import {
  buildHighSimilarityFallbackRelations,
  extractGlobalRelations,
  type ExistingRelationNeighborhood,
  type GlobalRelationConcept,
} from "@/lib/llm/extract-global-relations";
import { normalizeConceptRelation, relationIdentityKey } from "@/lib/relations";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const model: string = body.model ?? "gpt-4o-mini";

  const db = getDb();

  const analyzedBooks = await db.select({ id: books.id }).from(books).where(eq(books.analyzeStatus, "done"));
  const analyzedBookIds = analyzedBooks.map((book) => book.id);
  if (analyzedBookIds.length === 0) {
    return NextResponse.json({ error: "解析済みの本がありません" }, { status: 422 });
  }

  const conceptRows = await db
    .select({
      id: concepts.id,
      name: concepts.name,
      aliases: concepts.aliases,
      domain: concepts.domain,
      description: concepts.description,
      bookId: bookConcepts.bookId,
      importance: bookConcepts.importance,
      conceptType: bookConcepts.conceptType,
      specificity: bookConcepts.specificity,
    })
    .from(concepts)
    .innerJoin(bookConcepts, eq(bookConcepts.conceptId, concepts.id))
    .where(inArray(bookConcepts.bookId, analyzedBookIds));

  const globalConcepts = buildGlobalConcepts(conceptRows);
  if (globalConcepts.length < 2) {
    return NextResponse.json({ error: "概念が不足しています" }, { status: 422 });
  }

  const existingRows = await db.select().from(conceptRelations);
  const existingNeighborhood: ExistingRelationNeighborhood[] = existingRows.map((relation) => ({
    fromConceptId: relation.fromConceptId,
    toConceptId: relation.toConceptId,
  }));

  const llmRelations = await extractGlobalRelations({
    concepts: globalConcepts,
    existingRelations: existingNeighborhood,
    model,
  });

  const pendingRelations: Array<typeof conceptRelations.$inferInsert> = [];
  const seen = new Set<string>();
  for (const relation of llmRelations) {
    const normalized = normalizeConceptRelation({
      fromConceptId: relation.fromConceptId,
      toConceptId: relation.toConceptId,
      relationType: relation.relationType,
      bookId: null,
    });
    const key = relationIdentityKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    pendingRelations.push({
      fromConceptId: normalized.fromConceptId,
      toConceptId: normalized.toConceptId,
      relationType: normalized.relationType,
      evidence: relation.evidence,
      confidence: relation.confidence ?? 0.5,
      bookId: null,
      source: "llm",
    });
  }

  const fallbackRelations = buildHighSimilarityFallbackRelations({
    concepts: globalConcepts,
    existingRelations: pendingRelations.map((relation) => ({
      fromConceptId: relation.fromConceptId,
      toConceptId: relation.toConceptId,
    })),
  });

  for (const relation of fallbackRelations) {
    const normalized = normalizeConceptRelation({
      fromConceptId: relation.fromConceptId,
      toConceptId: relation.toConceptId,
      relationType: relation.relationType,
      bookId: null,
    });
    const key = relationIdentityKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    pendingRelations.push({
      fromConceptId: normalized.fromConceptId,
      toConceptId: normalized.toConceptId,
      relationType: normalized.relationType,
      evidence: relation.evidence,
      confidence: 0.35,
      bookId: null,
      source: "fallback",
    });
  }

  const minimumReplacementRelations = Math.ceil(globalConcepts.length * 1.2);
  if (pendingRelations.length < minimumReplacementRelations) {
    return NextResponse.json({
      ok: true,
      keptExistingRelations: true,
      reason: "generated_relation_count_below_global_minimum",
      conceptCount: globalConcepts.length,
      generatedRelationCount: pendingRelations.length,
      minimumReplacementRelations,
      llmRelationCount: llmRelations.length,
      fallbackRelationCount: fallbackRelations.length,
    });
  }

  await db
    .delete(conceptRelations)
    .where(inArray(conceptRelations.source, ["llm", "fallback"]));
  if (pendingRelations.length > 0) {
    await db.insert(conceptRelations).values(pendingRelations);
  }

  return NextResponse.json({
    ok: true,
    conceptCount: globalConcepts.length,
    totalRelations: pendingRelations.length,
    llmRelationCount: pendingRelations.filter((relation) => relation.source === "llm").length,
    fallbackRelationCount: pendingRelations.filter((relation) => relation.source === "fallback").length,
    targetRange: {
      min: Math.ceil(globalConcepts.length * 1.2),
      target: Math.ceil(globalConcepts.length * 1.45),
    },
  });
}

function buildGlobalConcepts(rows: Array<{
  id: number;
  name: string;
  aliases: string;
  domain: string;
  description: string | null;
  bookId: number;
  importance: number;
  conceptType: string;
  specificity: string;
}>): GlobalRelationConcept[] {
  const byConceptId = new Map<number, {
    id: number;
    name: string;
    aliases: string[];
    domain: string;
    description: string | null;
    bookIds: Set<number>;
    importanceTotal: number;
    importanceCount: number;
    conceptTypes: Set<string>;
    specificities: Set<string>;
  }>();

  for (const row of rows) {
    let concept = byConceptId.get(row.id);
    if (!concept) {
      concept = {
        id: row.id,
        name: row.name,
        aliases: parseAliases(row.aliases),
        domain: row.domain,
        description: row.description,
        bookIds: new Set<number>(),
        importanceTotal: 0,
        importanceCount: 0,
        conceptTypes: new Set<string>(),
        specificities: new Set<string>(),
      };
      byConceptId.set(row.id, concept);
    }
    concept.bookIds.add(row.bookId);
    concept.importanceTotal += row.importance;
    concept.importanceCount += 1;
    if (row.conceptType) concept.conceptTypes.add(row.conceptType);
    if (row.specificity) concept.specificities.add(row.specificity);
  }

  return [...byConceptId.values()].map((concept) => ({
    id: concept.id,
    name: concept.name,
    aliases: concept.aliases,
    domain: concept.domain,
    description: concept.description,
    bookCount: concept.bookIds.size,
    bookIds: [...concept.bookIds],
    averageImportance: concept.importanceCount > 0 ? concept.importanceTotal / concept.importanceCount : 0,
    conceptTypes: [...concept.conceptTypes],
    specificities: [...concept.specificities],
  }));
}
