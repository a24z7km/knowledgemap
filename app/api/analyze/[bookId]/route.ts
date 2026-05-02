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

async function fetchGoogleBooksDescription(title: string, author: string): Promise<string> {
  try {
    const q = encodeURIComponent(`intitle:${title} inauthor:${author}`);
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&langRestrict=ja`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const data = await res.json() as { items?: { volumeInfo?: { description?: string; categories?: string[] } }[] };
    const info = data.items?.[0]?.volumeInfo;
    if (!info) return "";
    const parts: string[] = [];
    if (info.description) parts.push(`[Google Books 概要]\n${info.description}`);
    if (info.categories?.length) parts.push(`[カテゴリ] ${info.categories.join(", ")}`);
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

async function runAnalysis(bookId: number, title: string, author: string, notes: string) {
  const db = getDb();
  try {
    // Step 1: Clean up previous analysis data for this book
    const prevLinks = await db.select({ conceptId: bookConcepts.conceptId }).from(bookConcepts).where(eq(bookConcepts.bookId, bookId));
    const prevConceptIds = prevLinks.map((l) => l.conceptId);

    await db.delete(conceptRelations).where(eq(conceptRelations.bookId, bookId));
    await db.delete(bookConcepts).where(eq(bookConcepts.bookId, bookId));

    // Delete concepts no longer referenced by any book
    for (const conceptId of prevConceptIds) {
      const remaining = await db.select().from(bookConcepts).where(eq(bookConcepts.conceptId, conceptId)).limit(1);
      if (remaining.length === 0) {
        await db.delete(conceptRelations).where(eq(conceptRelations.fromConceptId, conceptId));
        await db.delete(conceptRelations).where(eq(conceptRelations.toConceptId, conceptId));
        await db.delete(concepts).where(eq(concepts.id, conceptId));
      }
    }

    // Step 2: Enrich notes with Google Books description
    const googleDesc = await fetchGoogleBooksDescription(title, author);
    const enrichedNotes = [notes, googleDesc].filter(Boolean).join("\n\n");

    // Step 3: Extract concepts
    const extracted = await extractConcepts(title, author, enrichedNotes);

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
            aliases: JSON.stringify(ec.nameJa ? [ec.nameJa] : []),
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

    // Step 3: Extract relations (delete old ones for this book first to reflect re-analysis)
    await db.delete(conceptRelations).where(eq(conceptRelations.bookId, bookId));

    const relations = await extractRelations(title, extracted);
    for (const rel of relations) {
      const fromId = conceptIds[rel.from];
      const toId = conceptIds[rel.to];
      if (!fromId || !toId) continue;

      await db.insert(conceptRelations).values({
        fromConceptId: fromId,
        toConceptId: toId,
        relationType: rel.type,
        evidence: rel.evidence,
        bookId,
        source: "llm",
      });
    }

    await db.update(books).set({ analyzeStatus: "done" }).where(eq(books.id, bookId));
  } catch (err) {
    await db
      .update(books)
      .set({ analyzeStatus: "error", analyzeError: String(err) })
      .where(eq(books.id, bookId));
  }
}
