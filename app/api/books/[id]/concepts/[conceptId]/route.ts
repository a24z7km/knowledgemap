import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { bookConcepts } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

// DELETE /api/books/:id/concepts/:conceptId
// conceptId = bookConcepts.id (not concepts.id)
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; conceptId: string }> }
) {
  try {
    const { id, conceptId } = await params;
    const db = getDb();
    await db
      .delete(bookConcepts)
      .where(
        and(
          eq(bookConcepts.bookId, Number(id)),
          eq(bookConcepts.id, Number(conceptId))
        )
      );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
