import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, bookKeywordDrafts, KEYWORD_DRAFT_SOURCES } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const drafts = await db
    .select()
    .from(bookKeywordDrafts)
    .where(and(eq(bookKeywordDrafts.bookId, Number(id)), eq(bookKeywordDrafts.deletedByUser, false)));
  return NextResponse.json(drafts);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const draftId: number = body.draftId;
  if (!draftId) return NextResponse.json({ error: "draftId required" }, { status: 400 });

  const db = getDb();
  await db
    .update(bookKeywordDrafts)
    .set({ deletedByUser: true })
    .where(and(eq(bookKeywordDrafts.id, draftId), eq(bookKeywordDrafts.bookId, Number(id))));
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bookId = Number(id);
  const body = await req.json().catch(() => ({}));
  const text: string = body.text?.trim();
  const source: string = body.source ?? "user_input";

  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  if (!KEYWORD_DRAFT_SOURCES.includes(source as typeof KEYWORD_DRAFT_SOURCES[number])) {
    return NextResponse.json({ error: "invalid source" }, { status: 400 });
  }

  const db = getDb();
  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  const [draft] = await db
    .insert(bookKeywordDrafts)
    .values({ bookId, source: source as typeof KEYWORD_DRAFT_SOURCES[number], text, sourceUrl: null, evidenceText: null })
    .returning();
  return NextResponse.json(draft, { status: 201 });
}
