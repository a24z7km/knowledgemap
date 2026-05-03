import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, concepts, bookConcepts, conceptRelations, extractionRuns, rawConcepts } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { extractConcepts } from "@/lib/llm/extract-concepts";
import type { TargetCount } from "@/lib/llm/extract-concepts";
import { extractRelations } from "@/lib/llm/extract-relations";
import {
  extractCrossBookRelations,
  type CrossBookConcept,
  type CrossBookRelationContext,
} from "@/lib/llm/extract-cross-book-relations";
import { conceptLookupKeys, mergeAliases, parseAliases } from "@/lib/concepts/normalize";
import { scoreConceptCandidates } from "@/lib/concepts/scoring";
import { normalizeConceptRelation, relationIdentityKey } from "@/lib/relations";
import { fetchBookMetadata } from "@/lib/metadata/fetch-book-metadata";
import { generateConceptCandidates, tocLineCount } from "@/lib/llm/generate-concept-candidates";
import { isCancellationRequested, clearCancellation } from "@/lib/analysis-cancellation";

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


async function runAnalysis(bookId: number, title: string, author: string, notes: string, model = "gpt-4o-mini") {
  const db = getDb();
  let extractionRunId: number | null = null;
  let tocCount = 0;
  let rawCount = 0;
  let clusteredCount = 0;
  let promotedCount = 0;
  let droppedReasons: string[] = [];
  let sourceQuality: SourceQuality | null = null;
  let targetCount: TargetCount = { min: 12, max: 30 };

  try {
    const [run] = await db
      .insert(extractionRuns)
      .values({
        bookId,
        model,
        status: "running",
        sourceStats: JSON.stringify(buildSourceStats({ tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, targetCount })),
      })
      .returning({ id: extractionRuns.id });
    extractionRunId = run.id;

    // Step 1: Clean up previous analysis data for this book
    const prevLinks = await db.select({ conceptId: bookConcepts.conceptId }).from(bookConcepts).where(eq(bookConcepts.bookId, bookId));
    const prevConceptIds = prevLinks.map((l) => l.conceptId);

    await db.delete(conceptRelations).where(eq(conceptRelations.bookId, bookId));
    await db.delete(bookConcepts).where(eq(bookConcepts.bookId, bookId));
    await db.delete(rawConcepts).where(eq(rawConcepts.bookId, bookId));

    // Delete concepts no longer referenced by any book
    for (const conceptId of prevConceptIds) {
      const remaining = await db.select().from(bookConcepts).where(eq(bookConcepts.conceptId, conceptId)).limit(1);
      if (remaining.length === 0) {
        await db.delete(conceptRelations).where(eq(conceptRelations.fromConceptId, conceptId));
        await db.delete(conceptRelations).where(eq(conceptRelations.toConceptId, conceptId));
        await db.delete(concepts).where(eq(concepts.id, conceptId));
      }
    }

    if (isCancellationRequested(bookId)) {
      await finishExtractionRun(extractionRunId, "cancelled", { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons });
      clearCancellation(bookId);
      return;
    }

    // Step 2: Build structured extraction context (current book only — no existing concepts).
    const bookMetadata = await fetchBookMetadata(title, author);
    sourceQuality = measureSourceQuality({ bookMetadata, userNotes: notes });
    targetCount = targetCountForSourceQuality(sourceQuality);
    const enrichedNotes = buildExtractionSource({ title, author, notes, bookMetadata });
    sourceQuality = measureSourceQuality({ bookMetadata, userNotes: notes, sourceText: enrichedNotes });

    if (sourceQuality.meaningfulChars < 200) {
      droppedReasons = [
        ...droppedReasons,
        `insufficient_source: meaningfulChars=${sourceQuality.meaningfulChars} (<200)`,
      ];
      await updateExtractionRunStats(extractionRunId, { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, targetCount });
      await finishExtractionRun(
        extractionRunId,
        "failed",
        { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, targetCount },
        "insufficient_source"
      );
      await db
        .update(books)
        .set({ analyzeStatus: "failed", analyzeError: "insufficient_source" })
        .where(eq(books.id, bookId));
      return;
    }

    // Step 3: Pre-generate concept candidates from TOC / subjects / user notes
    const allToc = bookMetadata.sources.flatMap((s) => s.tableOfContents);
    const allSubjects = bookMetadata.sources.flatMap((s) => s.subjects);
    const candidates = generateConceptCandidates({ toc: allToc, subjects: allSubjects, userNotes: notes });
    tocCount = tocLineCount(allToc);
    await updateExtractionRunStats(extractionRunId, { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, targetCount });

    if (isCancellationRequested(bookId)) {
      await finishExtractionRun(extractionRunId, "cancelled", { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons });
      clearCancellation(bookId);
      return;
    }

    // Step 4: Extract concepts (LLM enriches candidates rather than extracting freely)
    const rawExtracted = await extractConcepts(title, author, enrichedNotes, model, candidates, targetCount);
    rawCount = rawExtracted.length;
    if (rawExtracted.length > 0) {
      await db.insert(rawConcepts).values(rawExtracted.map((concept, index) => ({
        extractionRunId,
        bookId,
        rawIndex: index,
        name: concept.name,
        nameJa: concept.nameJa,
        description: concept.description,
        category: concept.category,
        groundingType: concept.groundingType,
        evidenceText: concept.evidenceText,
        importance: concept.importance,
        specificity: concept.specificityScore,
        confidence: concept.confidence,
        sourceType: concept.sourceEvidence?.sourceType ?? null,
        sourceText: concept.sourceEvidence?.evidenceText ?? null,
        payload: JSON.stringify(concept),
      })));
    }

    const scored = scoreConceptCandidates(rawExtracted);
    const extracted = scored.filter((item) => item.status === "promoted").map((item) => item.concept);
    const scoreByName = new Map(scored.map((item) => [item.concept.name, item]));
    clusteredCount = scored.length;
    promotedCount = extracted.length;
    droppedReasons = scored
      .filter((item) => item.status === "rejected" && item.droppedReason)
      .map((item) => `${item.concept.name}: ${item.droppedReason}`);
    await updateExtractionRunStats(extractionRunId, { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, targetCount });

    // Step 5: Quality check
    const qualityWarnings = checkConceptQuality(extracted, tocCount);
    droppedReasons = [...droppedReasons, ...qualityWarnings.warnings];
    if (qualityWarnings.status === "failed") {
      await finishExtractionRun(extractionRunId, "failed", {
        tocCount,
        rawCount,
        clusteredCount,
        promotedCount,
        droppedReasons,
        sourceQuality,
        targetCount,
      }, `Concept extraction quality check failed: ${qualityWarnings.warnings.join("; ")}`);
      throw new Error(`Concept extraction quality check failed: ${qualityWarnings.warnings.join("; ")}`);
    }
    await updateExtractionRunStats(extractionRunId, { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, targetCount });

    if (isCancellationRequested(bookId)) {
      await finishExtractionRun(extractionRunId, "cancelled", { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons });
      clearCancellation(bookId);
      return;
    }

    // Step 6: Normalize + upsert concepts
    const existingConcepts = await db.select().from(concepts);
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
        conceptUpdates.groundingType = ec.groundingType;
        conceptUpdates.category = ec.category;
        const scoredConcept = scoreByName.get(ec.name);
        conceptUpdates.finalScore = scoredConcept?.finalScore ?? 1;
        conceptUpdates.status = scoredConcept?.status ?? "promoted";

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
            groundingType: ec.groundingType,
            category: ec.category,
            finalScore: scoreByName.get(ec.name)?.finalScore ?? 1,
            status: scoreByName.get(ec.name)?.status ?? "promoted",
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
          sourceEvidenceType: ec.sourceEvidence?.sourceType ?? null,
          sourceEvidenceText: ec.sourceEvidence?.evidenceText ?? null,
        });
      }
    }
    await updateExtractionRunStats(extractionRunId, { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, targetCount });

    if (isCancellationRequested(bookId)) {
      await finishExtractionRun(extractionRunId, "cancelled", { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons });
      clearCancellation(bookId);
      return;
    }

    // Step 7: Extract relations inside this book
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

    if (isCancellationRequested(bookId)) {
      await finishExtractionRun(extractionRunId, "cancelled", { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons });
      clearCancellation(bookId);
      return;
    }

    // Step 8: Extract high-confidence cross-book relations.
    const crossBookContext = await buildCrossBookRelationContext(bookId, title, author, extracted, conceptIds);
    const crossBookRelations = await extractCrossBookRelations({
      ...crossBookContext,
      title,
      author,
      model,
    });

    await saveCrossBookRelations(crossBookRelations, crossBookContext);

    await db.update(books).set({ analyzeStatus: "done" }).where(eq(books.id, bookId));
    await finishExtractionRun(extractionRunId, "completed", { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, targetCount });
  } catch (err) {
    await finishExtractionRun(
      extractionRunId,
      "failed",
      { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, targetCount },
      String(err)
    );
    await db
      .update(books)
      .set({ analyzeStatus: "failed", analyzeError: String(err) })
      .where(eq(books.id, bookId));
  }
}

interface ExtractionSourceStats {
  tocCount: number;
  rawCount: number;
  clusteredCount: number;
  promotedCount: number;
  droppedReasons: string[];
  sourceQuality?: SourceQuality | null;
  targetCount?: TargetCount;
}

interface SourceQuality {
  descriptionChars: number;
  tocLines: number;
  userNoteChars: number;
  meaningfulChars: number;
  sourceTextChars?: number;
}

function buildSourceStats(stats: ExtractionSourceStats) {
  return {
    tocCount: stats.tocCount,
    rawCount: stats.rawCount,
    clusteredCount: stats.clusteredCount,
    promotedCount: stats.promotedCount,
    droppedReasons: stats.droppedReasons,
    sourceQuality: stats.sourceQuality ?? null,
    targetCount: stats.targetCount ?? null,
  };
}

async function updateExtractionRunStats(runId: number | null, stats: ExtractionSourceStats) {
  if (runId == null) return;

  const db = getDb();
  await db
    .update(extractionRuns)
    .set({
      tocCount: stats.tocCount,
      rawCount: stats.rawCount,
      clusteredCount: stats.clusteredCount,
      promotedCount: stats.promotedCount,
      droppedReasons: JSON.stringify(stats.droppedReasons),
      sourceStats: JSON.stringify(buildSourceStats(stats)),
    })
    .where(eq(extractionRuns.id, runId));
}

async function finishExtractionRun(
  runId: number | null,
  status: "completed" | "failed" | "cancelled",
  stats: ExtractionSourceStats,
  error?: string
) {
  if (runId == null) return;

  const db = getDb();
  await db
    .update(extractionRuns)
    .set({
      status,
      tocCount: stats.tocCount,
      rawCount: stats.rawCount,
      clusteredCount: stats.clusteredCount,
      promotedCount: stats.promotedCount,
      droppedReasons: JSON.stringify(stats.droppedReasons),
      sourceStats: JSON.stringify(buildSourceStats(stats)),
      error: error ?? null,
      completedAt: new Date().toISOString(),
    })
    .where(eq(extractionRuns.id, runId));
}

function buildExtractionSource({
  title,
  author,
  notes,
  bookMetadata,
}: {
  title: string;
  author: string;
  notes: string;
  bookMetadata: import("@/lib/metadata/fetch-book-metadata").BookMetadata;
}) {
  const parts: string[] = [
    `[Book Metadata]
Title: ${title}
Author: ${author}
Subtitle: ${bookMetadata.subtitle || "(unknown)"}
Publisher: ${bookMetadata.publisher || "(unknown)"}
Published Date: ${bookMetadata.publishedDate || "(unknown)"}
ISBN: ${bookMetadata.isbn ?? "(unknown)"}
Page Count: ${bookMetadata.pageCount ?? "(unknown)"}`,
  ];

  parts.push(`[User Notes]
${notes.trim() || "(No user notes provided.)"}`);

  // Collect all table of contents across sources (prioritize first)
  const allToc: string[] = [];
  for (const src of bookMetadata.sources) {
    if (src.tableOfContents.length > 0) {
      allToc.push(`- source: ${src.source}\n${src.tableOfContents.map((item) => `  - ${item}`).join("\n")}`);
    }
  }
  parts.push(`[Table of Contents]
${allToc.length > 0 ? allToc.join("\n") : "(No table of contents found.)"}`);

  // Descriptions per source
  const descParts: string[] = [];
  for (const src of bookMetadata.sources) {
    if (src.description.trim()) {
      descParts.push(`- source: ${src.source}\n${src.description.trim()}`);
    }
  }
  parts.push(`[Descriptions]
${descParts.length > 0 ? descParts.join("\n\n") : "(No descriptions found.)"}`);

  // Subjects/categories per source
  const subjectParts: string[] = [];
  for (const src of bookMetadata.sources) {
    if (src.subjects.length > 0) {
      subjectParts.push(`- source: ${src.source}: ${src.subjects.join(", ")}`);
    }
  }
  parts.push(`[Subjects / Categories]
${subjectParts.length > 0 ? subjectParts.join("\n") : "(No subjects found.)"}`);

  return parts.join("\n\n");
}

function measureSourceQuality({
  bookMetadata,
  userNotes,
  sourceText,
}: {
  bookMetadata: import("@/lib/metadata/fetch-book-metadata").BookMetadata;
  userNotes: string;
  sourceText?: string;
}): SourceQuality {
  const descriptionChars = bookMetadata.sources.reduce((sum, source) => sum + source.description.trim().length, 0);
  const tocLines = tocLineCount(bookMetadata.sources.flatMap((source) => source.tableOfContents));
  const userNoteChars = userNotes.trim().length;

  return {
    descriptionChars,
    tocLines,
    userNoteChars,
    meaningfulChars: descriptionChars + tocLines * 20 + userNoteChars,
    sourceTextChars: sourceText?.length,
  };
}

function targetCountForSourceQuality(sourceQuality: SourceQuality): TargetCount {
  if (sourceQuality.meaningfulChars < 600) return { min: 3, max: 12 };
  if (sourceQuality.meaningfulChars < 1200) return { min: 8, max: 20 };
  return { min: 12, max: 30 };
}


function checkConceptQuality(
  extracted: Awaited<ReturnType<typeof extractConcepts>>,
  tocCount: number
): { status: "ok" | "warning" | "failed"; warnings: string[] } {
  const warnings: string[] = [];

  if (tocCount > 0 && extracted.length < tocCount * 0.5) {
    warnings.push(
      `TOC has ${tocCount} meaningful entries but only ${extracted.length} concepts were extracted (expected >= ${Math.ceil(tocCount * 0.5)})`
    );
  }

  const personCount = extracted.filter((c) => c.conceptType === "person").length;
  if (personCount / extracted.length > 0.3) {
    warnings.push(`${personCount}/${extracted.length} concepts are persons (>30%)`);
  }

  const genericCount = extracted.filter((c) => c.specificity === "generic").length;
  if (genericCount / extracted.length > 0.3) {
    warnings.push(`${genericCount}/${extracted.length} concepts are generic (>30%)`);
  }

  const noEvidence = extracted.filter((c) => !c.sourceEvidence?.evidenceText).length;
  if (noEvidence > 0) {
    warnings.push(`${noEvidence} concepts have no sourceEvidence text`);
  }

  if (tocCount > 0 && extracted.length < tocCount * 0.5) {
    return { status: "failed", warnings };
  }
  return { status: warnings.length > 0 ? "warning" : "ok", warnings };
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
