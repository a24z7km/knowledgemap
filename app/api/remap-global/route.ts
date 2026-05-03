import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, concepts, bookConcepts, conceptRelations } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { extractRelations } from "@/lib/llm/extract-relations";
import { normalizeConceptRelation, relationIdentityKey } from "@/lib/relations";
import type { ExtractedConcept } from "@/lib/llm/extract-concepts";
import type { ConceptDomain } from "@/lib/domains";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const model: string = body.model ?? "gpt-4o-mini";

  const db = getDb();

  // 解析済みの本を全件取得
  const allBooks = await db.select().from(books).where(eq(books.analyzeStatus, "done"));
  if (allBooks.length === 0) {
    return NextResponse.json({ error: "解析済みの本がありません" }, { status: 422 });
  }

  let totalRelations = 0;
  const results: { bookId: number; title: string; relationCount: number }[] = [];
  const pendingRelations: Array<typeof conceptRelations.$inferInsert> = [];

  for (const book of allBooks) {
    const rows = await db
      .select({
        id: concepts.id,
        name: concepts.name,
        description: concepts.description,
        domain: concepts.domain,
        importance: bookConcepts.importance,
        excerpt: bookConcepts.excerpt,
        sourceEvidenceText: bookConcepts.sourceEvidenceText,
      })
      .from(bookConcepts)
      .innerJoin(concepts, eq(bookConcepts.conceptId, concepts.id))
      .where(eq(bookConcepts.bookId, book.id));

    if (rows.length === 0) continue;

    const extracted: ExtractedConcept[] = rows.map((r) => ({
      name: r.name,
      nameJa: "",
      description: r.description ?? "",
      importance: (Math.min(5, Math.max(1, r.importance)) as 1 | 2 | 3 | 4 | 5),
      excerpt: r.excerpt ?? "",
      domain: (r.domain ?? "general") as ConceptDomain,
      category: "context" as const,
      groundingType: "source_explicit" as const,
      specificityScore: 3 as const,
      evidenceText: "",
      confidence: 1,
      conceptLevel: "supporting" as const,
      conceptType: "theme" as const,
      specificity: "domain_specific" as const,
      sourceEvidence: { sourceType: "table_of_contents" as const, evidenceText: r.sourceEvidenceText ?? "" },
    }));

    const relations = await extractRelations(book.title, extracted, model);
    const conceptIdByName = new Map(rows.map((r) => [r.name, r.id]));

    const seen = new Set<string>();
    for (const rel of relations) {
      const fromId = conceptIdByName.get(rel.from);
      const toId = conceptIdByName.get(rel.to);
      if (!fromId || !toId) continue;

      const normalized = normalizeConceptRelation({
        fromConceptId: fromId,
        toConceptId: toId,
        relationType: rel.type,
        bookId: book.id,
      });
      const key = relationIdentityKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);

      pendingRelations.push({
        fromConceptId: normalized.fromConceptId,
        toConceptId: normalized.toConceptId,
        relationType: normalized.relationType,
        evidence: rel.evidence,
        confidence: rel.confidence,
        bookId: book.id,
        source: rel.source ?? "llm",
      });
    }

    totalRelations += seen.size;
    results.push({ bookId: book.id, title: book.title, relationCount: seen.size });
  }

  const existingGeneratedRelations = await db
    .select({ id: conceptRelations.id })
    .from(conceptRelations)
    .where(inArray(conceptRelations.source, ["llm", "fallback"]));
  const minimumGeneratedRelations = existingGeneratedRelations.length > 0
    ? Math.max(1, Math.floor(existingGeneratedRelations.length * 0.5))
    : 1;

  if (pendingRelations.length < minimumGeneratedRelations) {
    return NextResponse.json({
      ok: true,
      keptExistingRelations: true,
      totalRelations: pendingRelations.length,
      existingRelationCount: existingGeneratedRelations.length,
      minimumGeneratedRelations,
      bookCount: allBooks.length,
      results,
    });
  }

  await db.delete(conceptRelations).where(inArray(conceptRelations.source, ["llm", "fallback"]));
  if (pendingRelations.length > 0) {
    await db.insert(conceptRelations).values(pendingRelations);
  }

  return NextResponse.json({ ok: true, totalRelations, bookCount: allBooks.length, results });
}
