import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, bookConcepts, concepts, conceptRelations } from "@/lib/db/schema";
import { desc } from "drizzle-orm";

const HEADERS = [
  "row_type",
  "book_id",
  "book_title",
  "book_author",
  "read_status",
  "analyze_status",
  "book_notes",
  "concept_id",
  "concept_name",
  "concept_aliases",
  "concept_domain",
  "concept_description",
  "importance",
  "excerpt",
  "concept_level",
  "concept_type",
  "specificity",
  "related_concept_id",
  "related_concept_name",
  "relation_type",
  "relation_evidence",
];

export async function GET() {
  try {
    const db = getDb();
    const [bookRows, bookConceptRows, conceptRows, relationRows] = await Promise.all([
      db.select().from(books).orderBy(desc(books.createdAt)),
      db.select().from(bookConcepts),
      db.select().from(concepts),
      db.select().from(conceptRelations),
    ]);

    const conceptById = new Map(conceptRows.map((concept) => [concept.id, concept]));
    const linksByBookId = groupBy(bookConceptRows, (link) => link.bookId);
    const relationsByBookId = groupBy(
      relationRows.filter((relation) => relation.bookId != null),
      (relation) => relation.bookId as number
    );

    const rows: string[][] = [HEADERS];

    for (const book of bookRows) {
      const links = linksByBookId.get(book.id) ?? [];
      const relations = relationsByBookId.get(book.id) ?? [];
      const relationConceptIds = new Set<number>();

      for (const relation of relations) {
        relationConceptIds.add(relation.fromConceptId);
        relationConceptIds.add(relation.toConceptId);

        const fromConcept = conceptById.get(relation.fromConceptId);
        const toConcept = conceptById.get(relation.toConceptId);
        const fromLink = links.find((link) => link.conceptId === relation.fromConceptId);

        rows.push([
          "relation",
          String(book.id),
          book.title,
          book.author,
          book.readStatus,
          book.analyzeStatus,
          book.notes ?? "",
          String(relation.fromConceptId),
          fromConcept?.name ?? "",
          fromConcept?.aliases ?? "[]",
          fromConcept?.domain ?? "",
          fromConcept?.description ?? "",
          fromLink ? String(fromLink.importance) : "",
          fromLink?.excerpt ?? "",
          fromLink?.conceptLevel ?? "",
          fromLink?.conceptType ?? "",
          fromLink?.specificity ?? "",
          String(relation.toConceptId),
          toConcept?.name ?? "",
          relation.relationType,
          relation.evidence ?? "",
        ]);
      }

      for (const link of links) {
        if (relationConceptIds.has(link.conceptId)) continue;
        const concept = conceptById.get(link.conceptId);

        rows.push([
          "concept",
          String(book.id),
          book.title,
          book.author,
          book.readStatus,
          book.analyzeStatus,
          book.notes ?? "",
          String(link.conceptId),
          concept?.name ?? "",
          concept?.aliases ?? "[]",
          concept?.domain ?? "",
          concept?.description ?? "",
          String(link.importance),
          link.excerpt ?? "",
          link.conceptLevel,
          link.conceptType,
          link.specificity,
          "",
          "",
          "",
          "",
        ]);
      }

      if (links.length === 0 && relations.length === 0) {
        rows.push([
          "book",
          String(book.id),
          book.title,
          book.author,
          book.readStatus,
          book.analyzeStatus,
          book.notes ?? "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
        ]);
      }
    }

    const csv = `\uFEFF${rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n")}`;
    const date = new Date().toISOString().slice(0, 10);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="knowledge-map-${date}.csv"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

function groupBy<T, K>(items: T[], getKey: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = getKey(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}

function escapeCsvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
