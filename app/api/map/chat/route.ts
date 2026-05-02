import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getDb } from "@/lib/db";
import { books, bookConcepts, concepts, conceptRelations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const client = new OpenAI();

interface ChatRequest {
  messages: { role: "user" | "assistant"; content: string }[];
  conceptIds: number[];
  model?: string;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as ChatRequest;
    const conceptIds = [...new Set((body.conceptIds ?? []).map(Number).filter(Number.isFinite))];
    const messages = body.messages ?? [];
    const model = body.model ?? "gpt-4o-mini";

    if (conceptIds.length === 0) {
      return NextResponse.json({ error: "conceptIds is required" }, { status: 400 });
    }
    if (messages.length === 0) {
      return NextResponse.json({ error: "messages is required" }, { status: 400 });
    }

    const db = getDb();
    const idSet = new Set(conceptIds);
    const allConcepts = await db.select().from(concepts);
    const selectedConcepts = allConcepts.filter((c) => idSet.has(c.id));

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

    const appearances = allBookConcepts.filter((a) => idSet.has(a.conceptId));
    const relations = (await db.select().from(conceptRelations)).filter(
      (r) => idSet.has(r.fromConceptId) && idSet.has(r.toConceptId)
    );
    const conceptNameById = new Map(selectedConcepts.map((c) => [c.id, c.name]));

    const contextText = [
      `[対象概念]`,
      selectedConcepts.map((c) => `- ${c.name}（${c.domain}）: ${c.description ?? ""}`).join("\n"),
      `[参照元の本と文脈]`,
      appearances.map((a) => `- ${a.bookTitle}（${a.bookAuthor}） → ${conceptNameById.get(a.conceptId)}: ${a.excerpt ?? ""}`).join("\n"),
      `[概念間の関係]`,
      relations.map((r) => `- ${conceptNameById.get(r.fromConceptId)} --[${r.relationType}]--> ${conceptNameById.get(r.toConceptId)}: ${r.evidence ?? ""}`).join("\n"),
    ].join("\n\n");

    const response = await client.chat.completions.create({
      model,
      max_completion_tokens: 1024,
      messages: [
        {
          role: "system",
          content: `あなたは読書知識マップのアシスタントです。ユーザーが選択した概念群についての質問に日本語で答えてください。
回答は簡潔に、ただし具体的に。必要に応じて箇条書きを使ってください。

${contextText}`,
        },
        ...messages,
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("LLM did not return content");

    return NextResponse.json({ message: content });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
