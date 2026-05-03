import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { books, extractionRuns } from "@/lib/db/schema";

export async function GET(_req: Request, { params }: { params: Promise<{ bookId: string }> }) {
  try {
    const { bookId } = await params;
    const numericBookId = Number(bookId);
    if (!Number.isFinite(numericBookId)) {
      return NextResponse.json({ error: "Invalid bookId" }, { status: 400 });
    }

    const db = getDb();
    const [book] = await db.select().from(books).where(eq(books.id, numericBookId)).limit(1);
    if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

    const runs = await db
      .select()
      .from(extractionRuns)
      .where(eq(extractionRuns.bookId, numericBookId))
      .orderBy(desc(extractionRuns.createdAt));

    return NextResponse.json({
      book: {
        id: book.id,
        title: book.title,
        author: book.author,
        analyzeStatus: book.analyzeStatus,
        analyzeError: book.analyzeError,
      },
      latestRun: runs[0] ? normalizeRun(runs[0]) : null,
      runs: runs.map(normalizeRun),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

function normalizeRun(run: typeof extractionRuns.$inferSelect) {
  return {
    ...run,
    droppedReasons: parseJsonArray(run.droppedReasons),
    sourceStats: parseJsonObject(run.sourceStats),
  };
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
