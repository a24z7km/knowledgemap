import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, bookKeywordDrafts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fetchBookMetadata } from "@/lib/metadata/fetch-book-metadata";
import { enrichFromWebSearch } from "@/lib/metadata/fetch-web-enrichment";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bookId = Number(id);
  const db = getDb();

  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const clearExisting: boolean = body.clear ?? false;

  if (clearExisting) {
    await db.delete(bookKeywordDrafts).where(eq(bookKeywordDrafts.bookId, bookId));
  }

  // 1. Fetch book metadata from book DB
  const bookMetadata = await fetchBookMetadata(book.title, book.author);

  const draftsToInsert: Parameters<typeof db.insert>[0] extends never
    ? never
    : Array<{
        bookId: number;
        source: "web_search" | "book_db" | "user_input" | "user_toc" | "user_summary";
        text: string;
        sourceUrl: string | null;
        evidenceText: string | null;
      }> = [];

  // Book DB sources → book_db
  for (const src of bookMetadata.sources) {
    const isWeb = src.source.startsWith("Web:");
    const draftSource = isWeb ? "web_search" as const : "book_db" as const;

    for (const tocLine of src.tableOfContents) {
      draftsToInsert.push({ bookId, source: draftSource, text: tocLine, sourceUrl: src.sourceUrl ?? null, evidenceText: null });
    }
    for (const subject of src.subjects) {
      draftsToInsert.push({ bookId, source: draftSource, text: subject, sourceUrl: src.sourceUrl ?? null, evidenceText: null });
    }
    if (src.description.trim()) {
      draftsToInsert.push({ bookId, source: draftSource, text: src.description.trim(), sourceUrl: src.sourceUrl ?? null, evidenceText: null });
    }
    if (src.review?.trim()) {
      draftsToInsert.push({ bookId, source: draftSource, text: src.review.trim(), sourceUrl: src.sourceUrl ?? null, evidenceText: null });
    }
  }

  // 2. Web enrichment (always run in Step 1)
  const webSources = await enrichFromWebSearch(book.title, book.author);
  for (const src of webSources) {
    for (const tocLine of src.tableOfContents) {
      draftsToInsert.push({ bookId, source: "web_search", text: tocLine, sourceUrl: src.sourceUrl ?? null, evidenceText: null });
    }
    for (const subject of src.subjects) {
      draftsToInsert.push({ bookId, source: "web_search", text: subject, sourceUrl: src.sourceUrl ?? null, evidenceText: null });
    }
    if (src.description.trim()) {
      draftsToInsert.push({ bookId, source: "web_search", text: src.description.trim(), sourceUrl: src.sourceUrl ?? null, evidenceText: null });
    }
    if (src.review?.trim()) {
      draftsToInsert.push({ bookId, source: "web_search", text: src.review.trim(), sourceUrl: src.sourceUrl ?? null, evidenceText: null });
    }
  }

  // 3. User input fields → user_toc / user_summary / user_input
  const userTocLines = (book.userToc ?? "").split(/[\n\r]+/).map((l) => l.trim()).filter(Boolean);
  for (const line of userTocLines) {
    draftsToInsert.push({ bookId, source: "user_toc", text: line, sourceUrl: null, evidenceText: null });
  }
  if (book.userSummary?.trim()) {
    draftsToInsert.push({ bookId, source: "user_summary", text: book.userSummary.trim(), sourceUrl: null, evidenceText: null });
  }
  if (book.userKeywords?.trim()) {
    for (const kw of book.userKeywords.split(/[,、\n]+/).map((k) => k.trim()).filter(Boolean)) {
      draftsToInsert.push({ bookId, source: "user_input", text: kw, sourceUrl: null, evidenceText: null });
    }
  }
  if (book.userQuotes?.trim()) {
    draftsToInsert.push({ bookId, source: "user_input", text: book.userQuotes.trim(), sourceUrl: null, evidenceText: null });
  }

  // Insert all drafts (deduplicate by text+source)
  const seen = new Set<string>();
  const deduped = draftsToInsert.filter((d) => {
    const key = `${d.source}||${d.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length > 0) {
    await db.insert(bookKeywordDrafts).values(deduped);
  }

  // Mark Step 1 as completed
  await db.update(books).set({ step1CompletedAt: new Date().toISOString() }).where(eq(books.id, bookId));

  const allDrafts = await db.select().from(bookKeywordDrafts).where(eq(bookKeywordDrafts.bookId, bookId));

  return NextResponse.json({ drafts: allDrafts, count: allDrafts.length });
}
