import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { concepts, bookConcepts, books, conceptRelations } from "@/lib/db/schema";
import { eq, or } from "drizzle-orm";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();

    const [concept] = await db.select().from(concepts).where(eq(concepts.id, Number(id)));
    if (!concept) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const appearances = await db
      .select({
        bookId: books.id,
        bookTitle: books.title,
        bookAuthor: books.author,
        importance: bookConcepts.importance,
        excerpt: bookConcepts.excerpt,
        conceptLevel: bookConcepts.conceptLevel,
        conceptType: bookConcepts.conceptType,
        specificity: bookConcepts.specificity,
      })
      .from(bookConcepts)
      .innerJoin(books, eq(bookConcepts.bookId, books.id))
      .where(eq(bookConcepts.conceptId, Number(id)));

    const relations = await db
      .select()
      .from(conceptRelations)
      .where(
        or(
          eq(conceptRelations.fromConceptId, Number(id)),
          eq(conceptRelations.toConceptId, Number(id))
        )
      );

    return NextResponse.json({ concept, appearances, relations });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
