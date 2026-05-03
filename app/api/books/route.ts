import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, extractionRuns } from "@/lib/db/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  try {
    const db = getDb();
    const [bookRows, runRows] = await Promise.all([
      db.select().from(books).orderBy(desc(books.createdAt)),
      db.select().from(extractionRuns).orderBy(desc(extractionRuns.createdAt)),
    ]);
    const latestRunByBookId = new Map<number, typeof runRows[number]>();
    for (const run of runRows) {
      if (!latestRunByBookId.has(run.bookId)) {
        latestRunByBookId.set(run.bookId, run);
      }
    }

    return NextResponse.json(
      bookRows.map((book) => ({
        ...book,
        latestExtractionRun: latestRunByBookId.get(book.id) ?? null,
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
