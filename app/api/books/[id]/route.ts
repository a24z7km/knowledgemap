import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, bookConcepts, concepts, extractionRuns, conceptRelations, rawConcepts, bookKeywordDrafts } from "@/lib/db/schema";
import { desc, eq, sql } from "drizzle-orm";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const [book] = await db.select().from(books).where(eq(books.id, Number(id)));
    if (!book) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const [latestExtractionRun] = await db
      .select()
      .from(extractionRuns)
      .where(eq(extractionRuns.bookId, Number(id)))
      .orderBy(desc(extractionRuns.createdAt))
      .limit(1);

    const [bcs, relCountRow] = await Promise.all([
      db.select({
        id: bookConcepts.id,
        importance: bookConcepts.importance,
        excerpt: bookConcepts.excerpt,
        conceptLevel: bookConcepts.conceptLevel,
        conceptType: bookConcepts.conceptType,
        specificity: bookConcepts.specificity,
        conceptId: concepts.id,
        conceptName: concepts.name,
        conceptDomain: concepts.domain,
        conceptDescription: concepts.description,
      })
        .from(bookConcepts)
        .innerJoin(concepts, eq(bookConcepts.conceptId, concepts.id))
        .where(eq(bookConcepts.bookId, Number(id))),
      db.select({ count: sql<number>`count(*)` })
        .from(conceptRelations)
        .where(eq(conceptRelations.bookId, Number(id))),
    ]);

    return NextResponse.json({
      book,
      concepts: bcs,
      latestExtractionRun: latestExtractionRun ?? null,
      conceptCount: bcs.length,
      relationCount: relCountRow[0]?.count ?? 0,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const db = getDb();
    const [book] = await db
      .update(books)
      .set({
        notes: body.notes ?? null,
        userToc: body.userToc ?? null,
        userSummary: body.userSummary ?? null,
        userKeywords: body.userKeywords ?? null,
        userQuotes: body.userQuotes ?? null,
      })
      .where(eq(books.id, Number(id)))
      .returning();
    if (!book) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(book);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const bookId = Number(id);
    const db = getDb();
    await db.delete(conceptRelations).where(eq(conceptRelations.bookId, bookId));
    await db.delete(bookKeywordDrafts).where(eq(bookKeywordDrafts.bookId, bookId));
    await db.delete(rawConcepts).where(eq(rawConcepts.bookId, bookId));
    await db.delete(extractionRuns).where(eq(extractionRuns.bookId, bookId));
    await db.delete(bookConcepts).where(eq(bookConcepts.bookId, bookId));
    await db.delete(books).where(eq(books.id, bookId));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
