import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, concepts, bookConcepts, conceptRelations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { extractConcepts } from "@/lib/llm/extract-concepts";
import { extractRelations } from "@/lib/llm/extract-relations";
import {
  extractCrossBookRelations,
  type CrossBookConcept,
  type CrossBookRelationContext,
} from "@/lib/llm/extract-cross-book-relations";
import { conceptLookupKeys, mergeAliases, parseAliases } from "@/lib/concepts/normalize";
import { normalizeConceptRelation, relationIdentityKey } from "@/lib/relations";

interface GoogleBooksInfo {
  description: string;
  categories: string[];
  publisher: string;
  publishedDate: string;
  pageCount: number | null;
  subtitle: string;
  tableOfContents: string[];
}

export async function POST(req: Request, { params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  const body = await req.json().catch(() => ({}));
  const model: string = body.model ?? "gpt-4o-mini";
  const db = getDb();

  const [book] = await db.select().from(books).where(eq(books.id, Number(bookId)));
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  await db
    .update(books)
    .set({ analyzeStatus: "analyzing", analyzeError: null })
    .where(eq(books.id, book.id));

  runAnalysis(book.id, book.title, book.author, book.notes ?? "", model).catch(() => {});

  return NextResponse.json({ status: "started" });
}

async function fetchGoogleBooksInfo(title: string, author: string): Promise<GoogleBooksInfo | null> {
  try {
    const q = encodeURIComponent(`intitle:${title} inauthor:${author}`);
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&langRestrict=ja`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      items?: {
        volumeInfo?: {
          description?: string;
          categories?: string[];
          publisher?: string;
          publishedDate?: string;
          pageCount?: number;
          subtitle?: string;
          tableOfContents?: string[];
        };
      }[];
    };
    const info = data.items?.[0]?.volumeInfo;
    if (!info) return null;
    return {
      description: info.description ?? "",
      categories: info.categories ?? [],
      publisher: info.publisher ?? "",
      publishedDate: info.publishedDate ?? "",
      pageCount: info.pageCount ?? null,
      subtitle: info.subtitle ?? "",
      tableOfContents: info.tableOfContents ?? [],
    };
  } catch {
    return null;
  }
}

async function runAnalysis(bookId: number, title: string, author: string, notes: string, model = "gpt-4o-mini") {
  const db = getDb();
  try {
    // Step 1: Clean up previous analysis data for this book
    const prevLinks = await db.select({ conceptId: bookConcepts.conceptId }).from(bookConcepts).where(eq(bookConcepts.bookId, bookId));
    const prevConceptIds = prevLinks.map((l) => l.conceptId);

    await db.delete(conceptRelations).where(eq(conceptRelations.bookId, bookId));
    await db.delete(bookConcepts).where(eq(bookConcepts.bookId, bookId));

    // Delete concepts no longer referenced by any book
    for (const conceptId of prevConceptIds) {
      const remaining = await db.select().from(bookConcepts).where(eq(bookConcepts.conceptId, conceptId)).limit(1);
      if (remaining.length === 0) {
        await db.delete(conceptRelations).where(eq(conceptRelations.fromConceptId, conceptId));
        await db.delete(conceptRelations).where(eq(conceptRelations.toConceptId, conceptId));
        await db.delete(concepts).where(eq(concepts.id, conceptId));
      }
    }

    // Step 2: Build structured extraction context.
    const googleBooks = await fetchGoogleBooksInfo(title, author);
    const existingConcepts = await db.select().from(concepts);
    const enrichedNotes = buildExtractionSource({
      title,
      author,
      notes,
      googleBooks,
      existingConcepts: existingConcepts.map((concept) => ({
        name: concept.name,
        domain: concept.domain,
        description: concept.description,
      })),
    });

    // Step 3: Extract concepts
    const extracted = await extractConcepts(title, author, enrichedNotes, model);

    // Step 4: Normalize + upsert concepts
    const conceptIndex = new Map<string, (typeof existingConcepts)[number]>();
    for (const concept of existingConcepts) {
      const aliases = parseAliases(concept.aliases);
      for (const key of conceptLookupKeys(concept.name, ...aliases)) {
        conceptIndex.set(key, concept);
      }
    }

    const conceptIds: Record<string, number> = {};
    for (const ec of extracted) {
      const extractedKeys = conceptLookupKeys(ec.name, ec.nameJa);
      const existing = extractedKeys.map((key) => conceptIndex.get(key)).find(Boolean);

      let conceptId: number;
      if (existing) {
        conceptId = existing.id;

        const aliases = mergeAliases(parseAliases(existing.aliases), ec.name, ec.nameJa);
        const conceptUpdates: Partial<typeof concepts.$inferInsert> = {};
        if (JSON.stringify(aliases) !== existing.aliases) {
          conceptUpdates.aliases = JSON.stringify(aliases);
        }
        if (existing.domain === "general" && ec.domain !== "general") {
          conceptUpdates.domain = ec.domain;
        }
        if (!existing.description && ec.description) {
          conceptUpdates.description = ec.description;
        }

        if (Object.keys(conceptUpdates).length > 0) {
          const [updated] = await db
            .update(concepts)
            .set(conceptUpdates)
            .where(eq(concepts.id, existing.id))
            .returning();

          for (const key of conceptLookupKeys(updated.name, ...parseAliases(updated.aliases))) {
            conceptIndex.set(key, updated);
          }
        }
      } else {
        const [inserted] = await db
          .insert(concepts)
          .values({
            name: ec.name,
            description: ec.description,
            domain: ec.domain,
            aliases: JSON.stringify(ec.nameJa ? [ec.nameJa] : []),
          })
          .returning();
        conceptId = inserted.id;

        for (const key of conceptLookupKeys(inserted.name, ...parseAliases(inserted.aliases))) {
          conceptIndex.set(key, inserted);
        }
      }
      conceptIds[ec.name] = conceptId;

      // Upsert book-concept link
      const link = await db
        .select()
        .from(bookConcepts)
        .where(and(eq(bookConcepts.bookId, bookId), eq(bookConcepts.conceptId, conceptId)))
        .limit(1);
      if (link.length === 0) {
        await db.insert(bookConcepts).values({
          bookId,
          conceptId,
          importance: ec.importance,
          excerpt: ec.excerpt,
          conceptLevel: ec.conceptLevel,
          conceptType: ec.conceptType,
          specificity: ec.specificity,
        });
      }
    }

    // Step 5: Extract relations inside this book
    await db.delete(conceptRelations).where(eq(conceptRelations.bookId, bookId));

    const relations = await extractRelations(title, extracted, model);
    const bookRelationKeys = new Set<string>();
    for (const rel of relations) {
      const fromId = conceptIds[rel.from];
      const toId = conceptIds[rel.to];
      if (!fromId || !toId) continue;

      const normalized = normalizeConceptRelation({
        fromConceptId: fromId,
        toConceptId: toId,
        relationType: rel.type,
        bookId,
      });
      const key = relationIdentityKey(normalized);
      if (bookRelationKeys.has(key)) continue;
      bookRelationKeys.add(key);

      await db.insert(conceptRelations).values({
        fromConceptId: normalized.fromConceptId,
        toConceptId: normalized.toConceptId,
        relationType: normalized.relationType,
        evidence: rel.evidence,
        bookId,
        source: "llm",
      });
    }

    // Step 6: Extract high-confidence cross-book relations.
    const crossBookContext = await buildCrossBookRelationContext(bookId, title, author, extracted, conceptIds);
    const crossBookRelations = await extractCrossBookRelations({
      ...crossBookContext,
      title,
      author,
      model,
    });

    await saveCrossBookRelations(crossBookRelations, crossBookContext);

    await db.update(books).set({ analyzeStatus: "done" }).where(eq(books.id, bookId));
  } catch (err) {
    await db
      .update(books)
      .set({ analyzeStatus: "failed", analyzeError: String(err) })
      .where(eq(books.id, bookId));
  }
}

function buildExtractionSource({
  title,
  author,
  notes,
  googleBooks,
  existingConcepts,
}: {
  title: string;
  author: string;
  notes: string;
  googleBooks: GoogleBooksInfo | null;
  existingConcepts: { name: string; domain: string; description: string | null }[];
}) {
  const parts: string[] = [
    `[Book Metadata]
Title: ${title}
Author: ${author}
Subtitle: ${googleBooks?.subtitle || "(unknown)"}
Publisher: ${googleBooks?.publisher || "(unknown)"}
Published Date: ${googleBooks?.publishedDate || "(unknown)"}
Page Count: ${googleBooks?.pageCount ?? "(unknown)"}`,
  ];

  parts.push(`[User Notes]
${notes.trim() || "(No user notes provided.)"}`);

  parts.push(`[Google Books Description]
${googleBooks?.description?.trim() || "(No Google Books description found.)"}`);

  parts.push(`[Categories]
${googleBooks?.categories?.length ? googleBooks.categories.join(", ") : "(No categories found.)"}`);

  parts.push(`[Table of Contents]
${googleBooks?.tableOfContents?.length ? googleBooks.tableOfContents.map((item) => `- ${item}`).join("\n") : "(No table of contents found.)"}`);

  parts.push(`[Existing Concepts Context]
Use this only to avoid accidental duplicates and to connect to the existing map. Do not let these existing broad concepts replace book-specific concepts from the current book.
${formatExistingConcepts(existingConcepts)}`);

  return parts.join("\n\n");
}

function formatExistingConcepts(existingConcepts: { name: string; domain: string; description: string | null }[]) {
  if (existingConcepts.length === 0) return "(No existing concepts yet.)";

  return existingConcepts
    .slice(0, 120)
    .map((concept) => `- ${concept.name} [${concept.domain}]${concept.description ? `: ${concept.description}` : ""}`)
    .join("\n");
}

async function buildCrossBookRelationContext(
  bookId: number,
  title: string,
  author: string,
  extracted: Awaited<ReturnType<typeof extractConcepts>>,
  conceptIds: Record<string, number>
) {
  const db = getDb();
  const currentConceptIds = new Set(Object.values(conceptIds));
  const allConcepts = await db.select().from(concepts);
  const allLinks = await db.select().from(bookConcepts);
  const allBooks = await db.select().from(books);
  const allRelations = await db.select().from(conceptRelations);

  const conceptById = new Map(allConcepts.map((concept) => [concept.id, concept]));
  const bookById = new Map(allBooks.map((book) => [book.id, book]));
  const linksByConceptId = new Map<number, typeof allLinks>();
  for (const link of allLinks) {
    linksByConceptId.set(link.conceptId, [...(linksByConceptId.get(link.conceptId) ?? []), link]);
  }

  const newConcepts: CrossBookConcept[] = extracted.flatMap((concept) => {
    const id = conceptIds[concept.name];
    if (!id) return [];
    return [{
      id,
      name: concept.name,
      aliases: concept.nameJa ? [concept.nameJa] : [],
      domain: concept.domain,
      description: concept.description,
      importance: concept.importance,
      excerpt: concept.excerpt,
      books: [{ id: bookId, title, author, importance: concept.importance, excerpt: concept.excerpt }],
    }];
  });

  const newDomains = new Set(newConcepts.map((concept) => concept.domain));
  const existingConcepts = allConcepts
    .filter((concept) => !currentConceptIds.has(concept.id))
    .map((concept) => {
      const appearances = (linksByConceptId.get(concept.id) ?? [])
        .filter((link) => link.bookId !== bookId)
        .flatMap((link) => {
          const book = bookById.get(link.bookId);
          if (!book) return [];
          return [{
            id: book.id,
            title: book.title,
            author: book.author,
            importance: link.importance,
            excerpt: link.excerpt,
          }];
        });

      return {
        id: concept.id,
        name: concept.name,
        aliases: parseAliases(concept.aliases),
        domain: concept.domain,
        description: concept.description,
        books: appearances,
      };
    })
    .filter((concept) => concept.books.length > 0)
    .sort((a, b) => scoreExistingConcept(b, newDomains) - scoreExistingConcept(a, newDomains))
    .slice(0, 120);

  const candidateIds = new Set(existingConcepts.map((concept) => concept.id));
  const existingRelations: CrossBookRelationContext[] = allRelations
    .filter((relation) => {
      const fromIsCandidate = candidateIds.has(relation.fromConceptId);
      const toIsCandidate = candidateIds.has(relation.toConceptId);
      const fromIsNew = currentConceptIds.has(relation.fromConceptId);
      const toIsNew = currentConceptIds.has(relation.toConceptId);
      return (fromIsCandidate && toIsCandidate) || (fromIsCandidate && toIsNew) || (fromIsNew && toIsCandidate);
    })
    .slice(0, 80)
    .flatMap((relation) => {
      const from = conceptById.get(relation.fromConceptId);
      const to = conceptById.get(relation.toConceptId);
      if (!from || !to) return [];
      const relationBook = relation.bookId ? bookById.get(relation.bookId) : null;
      return [{
        from: from.name,
        to: to.name,
        relationType: relation.relationType,
        evidence: relation.evidence,
        bookTitle: relationBook?.title ?? null,
      }];
    });

  return { newConcepts, existingConcepts, existingRelations };
}

function scoreExistingConcept(concept: CrossBookConcept, newDomains: Set<string>) {
  const sameDomainScore = newDomains.has(concept.domain) ? 10 : 0;
  const importanceScore = concept.books?.reduce((sum, book) => sum + (book.importance ?? 0), 0) ?? 0;
  const bookCountScore = concept.books?.length ?? 0;
  return sameDomainScore + importanceScore + bookCountScore;
}

async function saveCrossBookRelations(
  relations: Awaited<ReturnType<typeof extractCrossBookRelations>>,
  context: {
    newConcepts: CrossBookConcept[];
    existingConcepts: CrossBookConcept[];
  }
) {
  if (relations.length === 0) return;

  const db = getDb();
  const conceptIdByName = new Map(
    [...context.newConcepts, ...context.existingConcepts].map((concept) => [concept.name, concept.id])
  );
  const newConceptIds = new Set(context.newConcepts.map((concept) => concept.id));
  const existingConceptIds = new Set(context.existingConcepts.map((concept) => concept.id));
  const savedRelations = await db.select().from(conceptRelations);
  const savedRelationKeys = new Set(
    savedRelations.map((relation) =>
      relationIdentityKey({
        fromConceptId: relation.fromConceptId,
        toConceptId: relation.toConceptId,
        relationType: relation.relationType,
        bookId: relation.bookId,
      })
    )
  );

  for (const relation of relations) {
    if (relation.confidence < 0.65) continue;

    const fromId = conceptIdByName.get(relation.from);
    const toId = conceptIdByName.get(relation.to);
    if (!fromId || !toId || fromId === toId) continue;

    const crossesBookBoundary =
      (newConceptIds.has(fromId) && existingConceptIds.has(toId)) ||
      (existingConceptIds.has(fromId) && newConceptIds.has(toId));
    if (!crossesBookBoundary) continue;

    const normalized = normalizeConceptRelation({
      fromConceptId: fromId,
      toConceptId: toId,
      relationType: relation.relationType,
      bookId: null,
    });
    const key = relationIdentityKey(normalized);
    if (savedRelationKeys.has(key)) continue;

    await db.insert(conceptRelations).values({
      fromConceptId: normalized.fromConceptId,
      toConceptId: normalized.toConceptId,
      relationType: normalized.relationType,
      weight: relation.weight,
      source: "llm",
      bookId: null,
      evidence: `${relation.evidence}\n\nReason: ${relation.reason}\nConfidence: ${relation.confidence.toFixed(2)}`,
    });
    savedRelationKeys.add(key);
  }
}
