import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requestCancellation } from "@/lib/analysis-cancellation";

export async function POST(_req: Request, { params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  const id = Number(bookId);
  const db = getDb();

  const [book] = await db.select().from(books).where(eq(books.id, id));
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });
  if (book.analyzeStatus !== "analyzing") {
    return NextResponse.json({ error: "Not currently analyzing" }, { status: 400 });
  }

  requestCancellation(id);
  await db.update(books).set({ analyzeStatus: "pending", analyzeError: null }).where(eq(books.id, id));

  return NextResponse.json({ status: "cancelled" });
}
