import { chatWithRetry } from "@/lib/llm/openai-client";
import type { MetadataSource } from "./fetch-book-metadata";

interface SearchResult {
  title: string;
  url: string;
}

interface ExtractedWebSource {
  description?: string;
  tableOfContents?: string[];
  subjects?: string[];
  review?: string;
}

const USER_AGENT = "Mozilla/5.0 (compatible; KnowledgeMapBookMetadata/1.0)";
const MAX_RESULTS_PER_QUERY = 3;
const MAX_UNIQUE_RESULTS = 10;
const MAX_PAGE_CHARS = 16000;

export async function enrichFromWebSearch(title: string, author: string): Promise<MetadataSource[]> {
  const queries = [
    `${title} ${author} 目次`,
    `${title} ${author} 内容紹介`,
    `${title} 概要 要約`,
    `${title} site:bookmeter.com OR site:booklog.jp`,
  ];

  const searchResults = await collectSearchResults(queries);
  const sources: MetadataSource[] = [];

  for (const result of searchResults) {
    const pageText = await fetchPageText(result.url);
    if (!pageText) continue;

    const extracted = await extractMetadataFromPage({
      bookTitle: title,
      author,
      pageTitle: result.title,
      url: result.url,
      pageText,
    }).catch((): ExtractedWebSource => ({}));
    if (!hasUsefulSource(extracted)) continue;

    sources.push({
      source: `Web: ${hostnameForUrl(result.url)}`,
      description: extracted.description?.trim() ?? "",
      tableOfContents: normalizeLines(extracted.tableOfContents ?? []),
      subjects: normalizeLines(extracted.subjects ?? []),
      review: extracted.review?.trim() ?? "",
      sourceUrl: result.url,
    });
  }

  return sources;
}

async function collectSearchResults(queries: string[]): Promise<SearchResult[]> {
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  for (const query of queries) {
    const queryResults = await searchDuckDuckGo(query);
    for (const result of queryResults.slice(0, MAX_RESULTS_PER_QUERY)) {
      const normalizedUrl = normalizeResultUrl(result.url);
      if (!normalizedUrl || seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);
      results.push({ ...result, url: normalizedUrl });
      if (results.length >= MAX_UNIQUE_RESULTS) return results;
    }
  }

  return results;
}

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  try {
    const params = new URLSearchParams({ q: query, kl: "jp-jp" });
    const res = await fetch(`https://duckduckgo.com/html/?${params.toString()}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];

    const html = await res.text();
    return [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((match) => ({
        url: decodeHtml(match[1]),
        title: htmlToText(match[2]),
      }))
      .filter((result) => result.url && result.title);
  } catch {
    return [];
  }
}

async function fetchPageText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) return null;

    const raw = await res.text();
    const text = htmlToText(raw);
    if (text.length < 200) return null;
    return text.slice(0, MAX_PAGE_CHARS);
  } catch {
    return null;
  }
}

async function extractMetadataFromPage({
  bookTitle,
  author,
  pageTitle,
  url,
  pageText,
}: {
  bookTitle: string;
  author: string;
  pageTitle: string;
  url: string;
  pageText: string;
}): Promise<ExtractedWebSource> {
  const response = await chatWithRetry({
    model: "gpt-4o-mini",
    max_completion_tokens: 1200,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You extract bibliographic source text from fetched web pages.

Hard rules:
- Use ONLY text that appears in the provided page text.
- Do NOT summarize from memory or general knowledge.
- Do NOT invent a table of contents, description, review, subject, chapter, or keyword.
- If the page is not clearly about the requested book, return empty fields.
- Keep extracted Japanese text as Japanese.
- Return JSON only:
{
  "description": "publisher/bookstore description explicitly found on the page, or empty string",
  "tableOfContents": ["TOC line explicitly found on the page"],
  "subjects": ["category/keyword explicitly found on the page"],
  "review": "short review/impression text explicitly found on the page, or empty string"
}`,
      },
      {
        role: "user",
        content: `Book title: ${bookTitle}
Author: ${author || "(unknown)"}
Fetched URL: ${url}
Page title: ${pageTitle}

Fetched page text:
${pageText}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(content) as ExtractedWebSource;
  } catch {
    return {};
  }
}

function hasUsefulSource(source: ExtractedWebSource): boolean {
  return Boolean(
    source.description?.trim() ||
      source.review?.trim() ||
      normalizeLines(source.tableOfContents ?? []).length > 0 ||
      normalizeLines(source.subjects ?? []).length > 0
  );
}

function normalizeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const line of lines) {
    const clean = line.replace(/\s+/g, " ").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    normalized.push(clean);
  }
  return normalized;
}

function normalizeResultUrl(url: string): string | null {
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    const target = new URL(uddg ? decodeURIComponent(uddg) : parsed.href);
    if (!/^https?:$/.test(target.protocol)) return null;
    target.hash = "";
    return target.toString();
  } catch {
    return null;
  }
}

function hostnameForUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function htmlToText(html: string): string {
  return decodeHtml(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}
