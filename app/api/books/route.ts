import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books } from "@/lib/db/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  try {
    const db = getDb();
    const rows = await db.select().from(books).orderBy(desc(books.createdAt));
    return NextResponse.json(rows);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { title, author, readStatus, notes } = await req.json();
    if (!title || !author) {
      return NextResponse.json({ error: "title and author are required" }, { status: 400 });
    }

    const db = getDb();
    const [book] = await db
      .insert(books)
      .values({ title, author, readStatus: readStatus ?? "read", notes: notes ?? null })
      .returning();

    return NextResponse.json(book, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
