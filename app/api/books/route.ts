import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, extractionRuns, bookConcepts, conceptRelations } from "@/lib/db/schema";
import { desc, sql } from "drizzle-orm";

export async function GET() {
  try {
    const db = getDb();
    const [bookRows, runRows, conceptCountRows, relationCountRows] = await Promise.all([
      db.select().from(books).orderBy(desc(books.createdAt)),
      db.select().from(extractionRuns).orderBy(desc(extractionRuns.createdAt)),
      db.select({ bookId: bookConcepts.bookId, count: sql<number>`count(*)` })
        .from(bookConcepts).groupBy(bookConcepts.bookId),
      db.select({ bookId: conceptRelations.bookId, count: sql<number>`count(*)` })
        .from(conceptRelations).where(sql`${conceptRelations.bookId} is not null`)
        .groupBy(conceptRelations.bookId),
    ]);

    const latestRunByBookId = new Map<number, typeof runRows[number]>();
    for (const run of runRows) {
      if (!latestRunByBookId.has(run.bookId)) {
        latestRunByBookId.set(run.bookId, run);
      }
    }
    const conceptCountByBookId = new Map(conceptCountRows.map((r) => [r.bookId, r.count]));
    const relationCountByBookId = new Map(
      relationCountRows.map((r) => [r.bookId as number, r.count])
    );

    return NextResponse.json(
      bookRows.map((book) => ({
        ...book,
        latestExtractionRun: latestRunByBookId.get(book.id) ?? null,
        conceptCount: conceptCountByBookId.get(book.id) ?? 0,
        relationCount: relationCountByBookId.get(book.id) ?? 0,
      }))
    );
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { title, author, readStatus, notes, userToc, userSummary } = await req.json();
    if (!title || !author) {
      return NextResponse.json({ error: "title and author are required" }, { status: 400 });
    }

    const db = getDb();
    const [book] = await db
      .insert(books)
      .values({
        title,
        author,
        readStatus: readStatus ?? "read",
        notes: notes ?? null,
        userToc: userToc ?? null,
        userSummary: userSummary ?? null,
      })
      .returning();

    return NextResponse.json(book, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
