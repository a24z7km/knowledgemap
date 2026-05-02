export interface MetadataSource {
  source: string;
  description: string;
  tableOfContents: string[];
  subjects: string[];
  sourceUrl: string | null;
}

export interface BookMetadata {
  isbn: string | null;
  subtitle: string;
  publisher: string;
  publishedDate: string;
  pageCount: number | null;
  sources: MetadataSource[];
}

interface GoogleBooksVolume {
  volumeInfo?: {
    description?: string;
    categories?: string[];
    publisher?: string;
    publishedDate?: string;
    pageCount?: number;
    subtitle?: string;
    tableOfContents?: string[];
    industryIdentifiers?: { type: string; identifier: string }[];
    infoLink?: string;
  };
}

async function fetchGoogleBooks(title: string, author: string): Promise<{ meta: Partial<BookMetadata>; source: MetadataSource } | null> {
  try {
    const q = encodeURIComponent(`intitle:${title} inauthor:${author}`);
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&langRestrict=ja`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { items?: GoogleBooksVolume[] };
    const info = data.items?.[0]?.volumeInfo;
    if (!info) return null;

    const identifiers = info.industryIdentifiers ?? [];
    const isbn13 = identifiers.find((id) => id.type === "ISBN_13")?.identifier ?? null;
    const isbn10 = identifiers.find((id) => id.type === "ISBN_10")?.identifier ?? null;
    const isbn = isbn13 ?? isbn10 ?? null;

    return {
      meta: {
        isbn,
        subtitle: info.subtitle ?? "",
        publisher: info.publisher ?? "",
        publishedDate: info.publishedDate ?? "",
        pageCount: info.pageCount ?? null,
      },
      source: {
        source: "Google Books",
        description: info.description ?? "",
        tableOfContents: info.tableOfContents ?? [],
        subjects: info.categories ?? [],
        sourceUrl: info.infoLink ?? null,
      },
    };
  } catch {
    return null;
  }
}

interface OpenBDTextContent {
  TextType?: string;
  Text?: string;
}

interface OpenBDSubject {
  SubjectCode?: string;
  SubjectHeadingText?: string;
}

interface OpenBDEntry {
  summary?: {
    isbn?: string;
    publisher?: string;
    pubdate?: string;
  };
  onix?: {
    DescriptiveDetail?: {
      Subject?: OpenBDSubject[];
    };
    CollateralDetail?: {
      TextContent?: OpenBDTextContent[];
    };
  };
}

async function fetchOpenBD(isbn: string): Promise<MetadataSource | null> {
  try {
    const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${isbn}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as (OpenBDEntry | null)[];
    const entry = data?.[0];
    if (!entry) return null;

    const textContents = entry.onix?.CollateralDetail?.TextContent ?? [];
    const descriptionText = textContents
      .filter((t) => t.TextType === "03" || t.TextType === "02" || t.TextType === "01")
      .map((t) => t.Text ?? "")
      .filter(Boolean)
      .join("\n");

    const tocText = textContents
      .filter((t) => t.TextType === "04")
      .map((t) => t.Text ?? "")
      .filter(Boolean)
      .join("\n");

    const tocLines = tocText
      .split(/[\n\r]+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const subjects = (entry.onix?.DescriptiveDetail?.Subject ?? [])
      .map((s) => s.SubjectHeadingText ?? "")
      .filter(Boolean);

    return {
      source: "openBD",
      description: descriptionText,
      tableOfContents: tocLines,
      subjects,
      sourceUrl: `https://openbd.jp/?isbn=${isbn}`,
    };
  } catch {
    return null;
  }
}

async function fetchNDL(title: string, author: string): Promise<MetadataSource | null> {
  try {
    const params = new URLSearchParams({ title, creator: author, cnt: "3", mediatype: "1" });
    const res = await fetch(`https://iss.ndl.go.jp/api/opensearch?${params.toString()}`, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/xml" },
    });
    if (!res.ok) return null;
    const xml = await res.text();

    const descMatches = [...xml.matchAll(/<dc:description[^>]*>([\s\S]*?)<\/dc:description>/g)];
    const descriptions = descMatches
      .map((m) => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim())
      .filter(Boolean);

    const subjectMatches = [...xml.matchAll(/<dc:subject[^>]*>([\s\S]*?)<\/dc:subject>/g)];
    const subjects = subjectMatches
      .map((m) => m[1].trim())
      .filter(Boolean);

    const tocCandidates = descriptions.filter(
      (d) => d.includes("第") || d.includes("章") || d.includes("節") || d.includes("はじめに") || d.includes("おわりに")
    );
    const plainDescriptions = descriptions.filter((d) => !tocCandidates.includes(d));

    const tocLines = tocCandidates.flatMap((d) =>
      d.split(/[。、\n]/).map((s) => s.trim()).filter((s) => s.length > 1)
    );

    return {
      source: "NDL Search",
      description: plainDescriptions.join("\n"),
      tableOfContents: tocLines,
      subjects,
      sourceUrl: `https://iss.ndl.go.jp/api/opensearch?${params.toString()}`,
    };
  } catch {
    return null;
  }
}

export async function fetchBookMetadata(title: string, author: string): Promise<BookMetadata> {
  const [googleResult, ndlResult] = await Promise.allSettled([
    fetchGoogleBooks(title, author),
    fetchNDL(title, author),
  ]);

  const google = googleResult.status === "fulfilled" ? googleResult.value : null;
  const ndl = ndlResult.status === "fulfilled" ? ndlResult.value : null;

  const isbn = google?.meta.isbn ?? null;
  const openBDResult = isbn ? await fetchOpenBD(isbn) : null;

  const sources: MetadataSource[] = [];
  if (google?.source) sources.push(google.source);
  if (openBDResult) sources.push(openBDResult);
  if (ndl) sources.push(ndl);

  return {
    isbn,
    subtitle: google?.meta.subtitle ?? "",
    publisher: google?.meta.publisher ?? "",
    publishedDate: google?.meta.publishedDate ?? "",
    pageCount: google?.meta.pageCount ?? null,
    sources,
  };
}
