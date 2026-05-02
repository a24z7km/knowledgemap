import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, concepts, bookConcepts, conceptRelations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { extractConcepts } from "@/lib/llm/extract-concepts";
import { extractRelations } from "@/lib/llm/extract-relations";

export async function POST(_req: Request, { params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  const db = getDb();

  const [book] = await db.select().from(books).where(eq(books.id, Number(bookId)));
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  // Mark as analyzing
  await db
    .update(books)
    .set({ analyzeStatus: "analyzing", analyzeError: null })
    .where(eq(books.id, book.id));

  // Run async (fire-and-forget) so the API returns quickly
  runAnalysis(book.id, book.title, book.author, book.notes ?? "").catch(() => {});

  return NextResponse.json({ status: "started" });
}

async function runAnalysis(bookId: number, title: string, author: string, notes: string) {
  const db = getDb();
  try {
    // Step 1: Extract concepts
    const extracted = await extractConcepts(title, author, notes);

    // Step 2: Normalize + upsert concepts
    const conceptIds: Record<string, number> = {};
    for (const ec of extracted) {
      const existing = await db
        .select()
        .from(concepts)
        .where(eq(concepts.name, ec.name))
        .limit(1);

      let conceptId: number;
      if (existing.length > 0) {
        conceptId = existing[0].id;
      } else {
        const [inserted] = await db
          .insert(concepts)
          .values({
            name: ec.name,
            description: ec.description,
            domain: ec.domain,
            aliases: "[]",
          })
          .returning();
        conceptId = inserted.id;
      }
      conceptIds[ec.name] = conceptId;

      // Upsert book-concept link
      const link = await db
        .select()
        .from(bookConcepts)
        .where(and(eq(bookConcepts.bookId, bookId), eq(bookConcepts.conceptId, conceptId)))
        .limit(1);
      if (link.length === 0) {
        await db.insert(bookConcepts).values({
          bookId,
          conceptId,
          importance: ec.importance,
          excerpt: ec.excerpt,
        });
      }
    }

    // Step 3: Extract relations
    const relations = await extractRelations(title, extracted);
    for (const rel of relations) {
      const fromId = conceptIds[rel.from];
      const toId = conceptIds[rel.to];
      if (!fromId || !toId) continue;

      // Avoid duplicates
      const existing = await db
        .select()
        .from(conceptRelations)
        .where(
          and(
            eq(conceptRelations.fromConceptId, fromId),
            eq(conceptRelations.toConceptId, toId),
            eq(conceptRelations.bookId, bookId)
          )
        )
        .limit(1);
      if (existing.length === 0) {
        await db.insert(conceptRelations).values({
          fromConceptId: fromId,
          toConceptId: toId,
          relationType: rel.type,
          evidence: rel.evidence,
          bookId,
          source: "llm",
        });
      }
    }

    await db.update(books).set({ analyzeStatus: "done" }).where(eq(books.id, bookId));
  } catch (err) {
    await db
      .update(books)
      .set({ analyzeStatus: "error", analyzeError: String(err) })
      .where(eq(books.id, bookId));
  }
}
