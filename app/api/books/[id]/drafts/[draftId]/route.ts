import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { bookKeywordDrafts } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; draftId: string }> }
) {
  const { id, draftId } = await params;
  const body = await req.json().catch(() => ({}));
  const text: string = body.text?.trim();
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });

  const db = getDb();
  const [updated] = await db
    .update(bookKeywordDrafts)
    .set({ text })
    .where(and(eq(bookKeywordDrafts.id, Number(draftId)), eq(bookKeywordDrafts.bookId, Number(id))))
    .returning();

  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(updated);
}
