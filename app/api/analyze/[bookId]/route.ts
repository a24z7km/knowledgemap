import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, concepts, bookConcepts, conceptRelations, extractionRuns, rawConcepts, bookKeywordDrafts } from "@/lib/db/schema";
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
import { fetchBookMetadata, type SearchQualityStats, type SourceQualityStats } from "@/lib/metadata/fetch-book-metadata";
import { enrichFromWebSearch } from "@/lib/metadata/fetch-web-enrichment";
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

  runAnalysis(book.id, book.title, book.author, book.notes ?? "", book.userToc ?? "", book.userSummary ?? "", model, book.step1CompletedAt ?? null).catch(() => {});

  return NextResponse.json({ status: "started" });
}


async function runAnalysis(
  bookId: number,
  title: string,
  author: string,
  notes: string,
  userToc: string,
  userSummary: string,
  model = "gpt-4o-mini",
  step1CompletedAt: string | null = null
) {
  const db = getDb();
  let extractionRunId: number | null = null;
  let tocCount = 0;
  let rawCount = 0;
  let clusteredCount = 0;
  let promotedCount = 0;
  let droppedReasons: string[] = [];
  let sourceQuality: SourceQualityStats | null = null;
  let searchQuality: SearchQualityStats | null = null;
  let targetCount: TargetCount = { min: 12, max: 30 };

  try {
    const [run] = await db
      .insert(extractionRuns)
      .values({
        bookId,
        model,
        status: "running",
        sourceStats: JSON.stringify(buildSourceStats({ tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, searchQuality, targetCount })),
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

    // Step 2: Build structured extraction context.
    // When Step 1 has been completed, use persisted drafts as the source (no re-fetch).
    let bookMetadata: import("@/lib/metadata/fetch-book-metadata").BookMetadata;
    let enrichedNotes: string;

    if (step1CompletedAt) {
      const drafts = await db
        .select()
        .from(bookKeywordDrafts)
        .where(and(eq(bookKeywordDrafts.bookId, bookId), eq(bookKeywordDrafts.deletedByUser, false)));

      bookMetadata = buildMetadataFromDrafts(drafts);
      searchQuality = measureSearchQuality({ title, author, bookMetadata });
    } else {
      bookMetadata = await fetchBookMetadata(title, author);
      searchQuality = measureSearchQuality({ title, author, bookMetadata });
      sourceQuality = measureSourceQuality({ bookMetadata, userNotes: notes, userToc, userSummary });
      if (sourceQuality.total < 600) {
        const webSources = await enrichFromWebSearch(title, author);
        if (webSources.length > 0) {
          bookMetadata.sources.push(...webSources);
          sourceQuality = measureSourceQuality({ bookMetadata, userNotes: notes, userToc, userSummary });
        }
      }
    }

    targetCount = targetCountForSourceQuality(
      sourceQuality ?? measureSourceQuality({ bookMetadata, userNotes: notes, userToc, userSummary })
    );
    enrichedNotes = buildExtractionSource({ title, author, notes, userToc, userSummary, bookMetadata });
    sourceQuality = measureSourceQuality({ bookMetadata, userNotes: notes, userToc, userSummary, sourceText: enrichedNotes });

    if (sourceQuality.total < 200) {
      droppedReasons = [
        ...droppedReasons,
        `insufficient_source: total=${sourceQuality.total} (<200)`,
      ];
      await updateExtractionRunStats(extractionRunId, { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, searchQuality, targetCount });
      await finishExtractionRun(
        extractionRunId,
        "failed",
        { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, searchQuality, targetCount },
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
    const tocCandidates = bookMetadata.sources.flatMap((source) =>
      source.tableOfContents.map((text) => ({ text, sourceUrl: source.sourceUrl }))
    );
    const userTocLines = splitUserToc(userToc);
    const subjectCandidates = bookMetadata.sources.flatMap((source) =>
      source.subjects.map((text) => ({ text, sourceUrl: source.sourceUrl }))
    );
    const candidates = generateConceptCandidates({
      toc: [...tocCandidates, ...userTocLines],
      subjects: subjectCandidates,
      userNotes: [notes, userSummary].filter(Boolean).join("\n"),
    });
    tocCount = tocLineCount([...allToc, ...userTocLines]);
    await updateExtractionRunStats(extractionRunId, { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, searchQuality, targetCount });

    if (isCancellationRequested(bookId)) {
      await finishExtractionRun(extractionRunId, "cancelled", { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons });
      clearCancellation(bookId);
      return;
    }

    // Step 4: Extract concepts (LLM enriches candidates rather than extracting freely)
    const rawExtracted = await extractConcepts(title, author, enrichedNotes, model, candidates, targetCount);
    const extractionStrictness = extractionStrictnessForSourceQuality(sourceQuality);
    const extractionPool = extractionStrictness === "source_explicit_only"
      ? rawExtracted.map((concept) => concept.groundingType === "source_explicit"
        ? concept
        : { ...concept, confidence: 0, groundingType: "model_prior" as const })
      : rawExtracted;
    rawCount = extractionPool.length;
    if (extractionPool.length > 0) {
      await db.insert(rawConcepts).values(extractionPool.map((concept, index) => ({
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

    const scored = scoreConceptCandidates(extractionPool).map((item) => {
      if (extractionStrictness === "source_explicit_only" && item.concept.groundingType !== "source_explicit") {
        return {
          ...item,
          finalScore: 0,
          status: "rejected" as const,
          droppedReason: "source_quality_requires_source_explicit",
        };
      }
      return item;
    });
    const extracted = scored.filter((item) => item.status === "promoted").map((item) => item.concept);
    const scoreByName = new Map(scored.map((item) => [item.concept.name, item]));
    clusteredCount = scored.length;
    promotedCount = extracted.length;
    droppedReasons = scored
      .filter((item) => item.status === "rejected" && item.droppedReason)
      .map((item) => `${item.concept.name}: ${item.droppedReason}`);
    await updateExtractionRunStats(extractionRunId, { tocCount, rawCount, clusteredCount, promotedCount, droppedReasons, sourceQuality, searchQuality, targetCount });

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
  sourceQuality?: SourceQualityStats | null;
  searchQuality?: SearchQualityStats | null;
  targetCount?: TargetCount;
}

function buildSourceStats(stats: ExtractionSourceStats) {
  return {
    tocCount: stats.tocCount,
    rawCount: stats.rawCount,
    clusteredCount: stats.clusteredCount,
    promotedCount: stats.promotedCount,
    droppedReasons: stats.droppedReasons,
    sourceQuality: stats.sourceQuality ?? null,
    searchQuality: stats.searchQuality ?? null,
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
  userToc,
  userSummary,
  bookMetadata,
}: {
  title: string;
  author: string;
  notes: string;
  userToc: string;
  userSummary: string;
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
      allToc.push(`- source: ${src.source}${formatSourceUrl(src.sourceUrl)}\n${src.tableOfContents.map((item) => `  - ${item}`).join("\n")}`);
    }
  }
  const userTocLines = splitUserToc(userToc);
  if (userTocLines.length > 0) {
    allToc.unshift(`- source: User TOC\n${userTocLines.map((item) => `  - ${item}`).join("\n")}`);
  }
  parts.push(`[Table of Contents]
${allToc.length > 0 ? allToc.join("\n") : "(No table of contents found.)"}`);

  // Descriptions per source
  const descParts: string[] = [];
  for (const src of bookMetadata.sources) {
    if (src.description.trim()) {
      descParts.push(`- source: ${src.source}${formatSourceUrl(src.sourceUrl)}\n${src.description.trim()}`);
    }
  }
  if (userSummary.trim()) {
    descParts.unshift(`- source: User Summary\n${userSummary.trim()}`);
  }
  parts.push(`[Descriptions]
${descParts.length > 0 ? descParts.join("\n\n") : "(No descriptions found.)"}`);

  const reviewParts: string[] = [];
  for (const src of bookMetadata.sources) {
    if (src.review?.trim()) {
      reviewParts.push(`- source: ${src.source}${formatSourceUrl(src.sourceUrl)}\n${src.review.trim()}`);
    }
  }
  parts.push(`[Reviews]
${reviewParts.length > 0 ? reviewParts.join("\n\n") : "(No reviews found.)"}`);

  // Subjects/categories per source
  const subjectParts: string[] = [];
  for (const src of bookMetadata.sources) {
    if (src.subjects.length > 0) {
      subjectParts.push(`- source: ${src.source}${formatSourceUrl(src.sourceUrl)}: ${src.subjects.join(", ")}`);
    }
  }
  parts.push(`[Subjects / Categories]
${subjectParts.length > 0 ? subjectParts.join("\n") : "(No subjects found.)"}`);

  return parts.join("\n\n");
}

function formatSourceUrl(sourceUrl: string | null): string {
  return sourceUrl ? `\n  Source URL: ${sourceUrl}` : "";
}

function measureSourceQuality({
  bookMetadata,
  userNotes,
  userToc,
  userSummary,
  sourceText,
}: {
  bookMetadata: import("@/lib/metadata/fetch-book-metadata").BookMetadata;
  userNotes: string;
  userToc: string;
  userSummary: string;
  sourceText?: string;
}): SourceQualityStats {
  const descriptionChars =
    bookMetadata.sources.reduce((sum, source) => sum + source.description.trim().length, 0) +
    userSummary.trim().length;
  const tocLines = tocLineCount([...bookMetadata.sources.flatMap((source) => source.tableOfContents), ...splitUserToc(userToc)]);
  const subjectsCount = bookMetadata.sources.reduce((sum, source) => sum + source.subjects.length, 0);
  const userNotesChars = userNotes.trim().length;
  const reviewChars = bookMetadata.sources.reduce((sum, source) => sum + (source.review?.trim().length ?? 0), 0);
  const total = descriptionChars + reviewChars + tocLines * 30 + subjectsCount * 10 + userNotesChars * 2;

  return {
    descriptionChars,
    tocLines,
    subjectsCount,
    userNotesChars,
    reviewChars,
    total,
    sourceTextChars: sourceText?.length,
  };
}

function measureSearchQuality({
  title,
  author,
  bookMetadata,
}: {
  title: string;
  author: string;
  bookMetadata: import("@/lib/metadata/fetch-book-metadata").BookMetadata;
}): SearchQualityStats {
  return {
    hasTitle: title.trim().length > 0,
    hasAuthor: author.trim().length > 0,
    hasSubtitle: bookMetadata.subtitle.trim().length > 0,
    hasIsbn: Boolean(bookMetadata.isbn),
  };
}

function targetCountForSourceQuality(sourceQuality: SourceQualityStats): TargetCount {
  if (sourceQuality.total < 600) return { min: 5, max: 12 };
  return { min: 10, max: 30 };
}

function extractionStrictnessForSourceQuality(sourceQuality: SourceQualityStats): "source_explicit_only" | "normal" {
  return sourceQuality.total < 600 ? "source_explicit_only" : "normal";
}

function splitUserToc(userToc: string): string[] {
  return userToc
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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

function buildMetadataFromDrafts(
  drafts: import("@/lib/db/schema").BookKeywordDraft[]
): import("@/lib/metadata/fetch-book-metadata").BookMetadata {
  const bySource = new Map<string, typeof drafts>();
  for (const d of drafts) {
    const key = d.sourceUrl ?? d.source;
    (bySource.get(key) ?? bySource.set(key, []).get(key)!).push(d);
  }

  const sources: import("@/lib/metadata/fetch-book-metadata").MetadataSource[] = [];
  for (const [, items] of bySource) {
    const first = items[0];
    const toc: string[] = [];
    const subjects: string[] = [];
    const descriptions: string[] = [];

    for (const item of items) {
      if (item.source === "user_toc") {
        toc.push(item.text);
      } else if (item.source === "user_input") {
        subjects.push(item.text);
      } else {
        // web_search / book_db / user_summary — treat long text as description, short as subject
        if (item.text.length > 80) {
          descriptions.push(item.text);
        } else {
          subjects.push(item.text);
        }
      }
    }

    sources.push({
      source: first.sourceUrl ? `Web: ${hostnameFromUrl(first.sourceUrl)}` : first.source,
      description: descriptions.join("\n\n"),
      tableOfContents: toc,
      subjects,
      review: "",
      sourceUrl: first.sourceUrl ?? null,
    });
  }

  return {
    isbn: null,
    subtitle: "",
    publisher: "",
    publishedDate: "",
    pageCount: null,
    sources,
  };
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}
