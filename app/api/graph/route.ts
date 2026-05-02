import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { concepts, conceptRelations, bookConcepts } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const domainFilter = searchParams.get("domain");

    const db = getDb();

    // Get all concepts with book count
    const allConcepts = await db
      .select({
        id: concepts.id,
        name: concepts.name,
        aliases: concepts.aliases,
        domain: concepts.domain,
        description: concepts.description,
        bookCount: sql<number>`count(distinct ${bookConcepts.bookId})`,
        bookIds: sql<string | null>`group_concat(distinct ${bookConcepts.bookId})`,
      })
      .from(concepts)
      .leftJoin(bookConcepts, eq(bookConcepts.conceptId, concepts.id))
      .groupBy(concepts.id);

    // Get all relations
    const allRelations = await db.select().from(conceptRelations);

    // Filter by domain if requested
    let filteredConcepts = allConcepts;
    if (domainFilter && domainFilter !== "all") {
      filteredConcepts = allConcepts.filter((c) => c.domain === domainFilter);
    }

    const conceptIdSet = new Set(filteredConcepts.map((c) => c.id));
    const filteredRelations = allRelations.filter(
      (r) => conceptIdSet.has(r.fromConceptId) && conceptIdSet.has(r.toConceptId)
    );

    return NextResponse.json({
      nodes: filteredConcepts.map((concept) => ({
        ...concept,
        bookIds: concept.bookIds?.split(",").map(Number).filter(Number.isFinite) ?? [],
      })),
      edges: filteredRelations,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
