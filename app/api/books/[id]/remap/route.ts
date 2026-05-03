import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, concepts, bookConcepts, conceptRelations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { extractRelations } from "@/lib/llm/extract-relations";
import { normalizeConceptRelation, relationIdentityKey } from "@/lib/relations";
import type { ExtractedConcept } from "@/lib/llm/extract-concepts";
import type { ConceptDomain } from "@/lib/domains";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bookId = Number(id);
  const body = await req.json().catch(() => ({}));
  const model: string = body.model ?? "gpt-4o-mini";

  const db = getDb();
  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  // Load current concepts for this book
  const rows = await db
    .select({
      name: concepts.name,
      description: concepts.description,
      domain: concepts.domain,
      importance: bookConcepts.importance,
      excerpt: bookConcepts.excerpt,
      sourceEvidenceText: bookConcepts.sourceEvidenceText,
    })
    .from(bookConcepts)
    .innerJoin(concepts, eq(bookConcepts.conceptId, concepts.id))
    .where(eq(bookConcepts.bookId, bookId));

  if (rows.length === 0) {
    return NextResponse.json({ error: "概念がありません。先に Step 2 を実行してください。" }, { status: 422 });
  }

  // Build minimal ExtractedConcept[] for extractRelations
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

  // Replace book-scoped relations only
  await db.delete(conceptRelations).where(eq(conceptRelations.bookId, bookId));

  const relations = await extractRelations(book.title, extracted, model);

  // Load concept id map
  const conceptRows = await db
    .select({ id: concepts.id, name: concepts.name })
    .from(bookConcepts)
    .innerJoin(concepts, eq(bookConcepts.conceptId, concepts.id))
    .where(eq(bookConcepts.bookId, bookId));
  const conceptIdByName = new Map(conceptRows.map((r) => [r.name, r.id]));

  const seen = new Set<string>();
  for (const rel of relations) {
    const fromId = conceptIdByName.get(rel.from);
    const toId = conceptIdByName.get(rel.to);
    if (!fromId || !toId) continue;

    const normalized = normalizeConceptRelation({ fromConceptId: fromId, toConceptId: toId, relationType: rel.type, bookId });
    const key = relationIdentityKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);

    await db.insert(conceptRelations).values({
      fromConceptId: normalized.fromConceptId,
      toConceptId: normalized.toConceptId,
      relationType: normalized.relationType,
      evidence: rel.evidence,
      confidence: rel.confidence,
      bookId,
      source: rel.source ?? "llm",
    });
  }

  // Clean up stale cross-book relations involving concepts no longer in this book
  const allBookLinks = await db.select({ conceptId: bookConcepts.conceptId }).from(bookConcepts);
  const allLinkedConceptIds = new Set(allBookLinks.map((l) => l.conceptId));

  const crossBookRels = await db
    .select()
    .from(conceptRelations)
    .where(and(eq(conceptRelations.source, "llm")));

  for (const rel of crossBookRels) {
    if (rel.bookId !== null) continue; // skip book-scoped (already replaced)
    const fromStale = !allLinkedConceptIds.has(rel.fromConceptId);
    const toStale = !allLinkedConceptIds.has(rel.toConceptId);
    if (fromStale || toStale) {
      await db.delete(conceptRelations).where(eq(conceptRelations.id, rel.id));
    }
  }

  return NextResponse.json({ ok: true, relationCount: seen.size });
}
