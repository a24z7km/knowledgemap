import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getDb } from "@/lib/db";
import { books, bookConcepts, concepts, conceptRelations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const client = new OpenAI();

interface InsightRequest {
  conceptIds?: number[];
  model?: string;
}

interface BookSuggestion {
  title: string;
  author: string;
  reason: string;
  angle: string;
}

interface MapInsight {
  summary: string;
  keyIdeas: string[];
  developmentQuestions: string[];
  bookSuggestions: BookSuggestion[];
}

const FALLBACK_INSIGHT: MapInsight = {
  summary: "",
  keyIdeas: [],
  developmentQuestions: [],
  bookSuggestions: [],
};

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as InsightRequest;
    const conceptIds = [...new Set((body.conceptIds ?? []).map(Number).filter(Number.isFinite))];
    if (conceptIds.length === 0) {
      return NextResponse.json({ error: "conceptIds is required" }, { status: 400 });
    }
    if (conceptIds.length > 50) {
      return NextResponse.json({ error: "Select up to 50 concepts" }, { status: 400 });
    }

    const db = getDb();
    const idSet = new Set(conceptIds);
    const allConcepts = await db.select().from(concepts);
    const selectedConcepts = allConcepts.filter((concept) => idSet.has(concept.id));

    if (selectedConcepts.length === 0) {
      return NextResponse.json({ error: "No concepts found" }, { status: 404 });
    }

    const allBookConcepts = await db
      .select({
        conceptId: bookConcepts.conceptId,
        importance: bookConcepts.importance,
        excerpt: bookConcepts.excerpt,
        bookId: books.id,
        bookTitle: books.title,
        bookAuthor: books.author,
      })
      .from(bookConcepts)
      .innerJoin(books, eq(bookConcepts.bookId, books.id));

    const appearances = allBookConcepts.filter((appearance) => idSet.has(appearance.conceptId));
    const existingBooks = await db.select({ title: books.title, author: books.author }).from(books);
    const relations = (await db.select().from(conceptRelations)).filter(
      (relation) => idSet.has(relation.fromConceptId) && idSet.has(relation.toConceptId)
    );

    const conceptNameById = new Map(selectedConcepts.map((concept) => [concept.id, concept.name]));
    const context = {
      concepts: selectedConcepts.map((concept) => ({
        id: concept.id,
        name: concept.name,
        aliases: safeJsonArray(concept.aliases),
        domain: concept.domain,
        description: concept.description,
      })),
      appearances: appearances.map((appearance) => ({
        concept: conceptNameById.get(appearance.conceptId),
        bookTitle: appearance.bookTitle,
        bookAuthor: appearance.bookAuthor,
        importance: appearance.importance,
        excerpt: appearance.excerpt,
      })),
      relations: relations.map((relation) => ({
        from: conceptNameById.get(relation.fromConceptId),
        to: conceptNameById.get(relation.toConceptId),
        type: relation.relationType,
        evidence: relation.evidence,
      })),
      existingBooks,
    };

    const response = await client.chat.completions.create({
      model: body.model ?? "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You summarize selected regions of a reading knowledge map and suggest books that help develop the user's thinking.

Return JSON with this exact shape:
{
  "summary": "Japanese paragraph, 3-5 sentences",
  "keyIdeas": ["Japanese bullet", "..."],
  "developmentQuestions": ["Japanese question", "..."],
  "bookSuggestions": [
    { "title": "Book title", "author": "Author", "reason": "Japanese reason", "angle": "Japanese learning angle" }
  ]
}

Guidelines:
- Write in Japanese.
- Ground the summary in the selected concepts, their descriptions, source books, and relations.
- Suggest books that extend, challenge, or deepen the selected theme.
- Avoid recommending books already listed in existingBooks unless they are essential.
- Prefer well-known, real books and include authors.
- Return 3-5 keyIdeas, 2-4 developmentQuestions, and 4-6 bookSuggestions.`,
        },
        {
          role: "user",
          content: JSON.stringify(context),
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("LLM did not return content");

    const insight = normalizeInsight(JSON.parse(content));
    return NextResponse.json(insight);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function normalizeInsight(value: unknown): MapInsight {
  if (!value || typeof value !== "object") return FALLBACK_INSIGHT;
  const input = value as Partial<MapInsight>;
  return {
    summary: typeof input.summary === "string" ? input.summary : "",
    keyIdeas: Array.isArray(input.keyIdeas) ? input.keyIdeas.filter(isString).slice(0, 5) : [],
    developmentQuestions: Array.isArray(input.developmentQuestions)
      ? input.developmentQuestions.filter(isString).slice(0, 4)
      : [],
    bookSuggestions: Array.isArray(input.bookSuggestions)
      ? input.bookSuggestions
          .filter(isBookSuggestion)
          .map((book) => ({
            title: book.title,
            author: book.author,
            reason: book.reason,
            angle: book.angle,
          }))
          .slice(0, 6)
      : [],
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBookSuggestion(value: unknown): value is BookSuggestion {
  if (!value || typeof value !== "object") return false;
  const book = value as BookSuggestion;
  return [book.title, book.author, book.reason, book.angle].every(isString);
}
