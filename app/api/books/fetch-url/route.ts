import { NextResponse } from "next/server";
import OpenAI from "openai";

const client = new OpenAI();

export async function POST(req: Request) {
  try {
    const { url } = await req.json();
    if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });

    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BookFetcher/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Failed to fetch URL: ${res.status}`);

    const html = await res.text();
    // Trim HTML to avoid huge token usage
    const trimmed = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 4000);

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content: "Extract book title and author from the webpage text. Return JSON only: {\"title\": \"...\", \"author\": \"...\"}. If not found, use null.",
        },
        { role: "user", content: trimmed },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    const data = JSON.parse(content) as { title?: string | null; author?: string | null };

    if (!data.title) return NextResponse.json({ error: "タイトルを取得できませんでした" }, { status: 422 });

    return NextResponse.json({ title: data.title, author: data.author ?? "" });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
