import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, bookConcepts, concepts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const [book] = await db.select().from(books).where(eq(books.id, Number(id)));
    if (!book) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const bcs = await db
      .select({
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
      .where(eq(bookConcepts.bookId, Number(id)));

    return NextResponse.json({ book, concepts: bcs });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    await db.delete(books).where(eq(books.id, Number(id)));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
