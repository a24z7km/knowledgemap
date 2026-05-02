import type { SourceType } from "./extract-concepts";

export interface ConceptCandidate {
  text: string;
  sourceType: SourceType;
  evidenceText: string;
}

const NOISE_PATTERNS = [
  /公式本/,
  /改訂版/,
  /文庫版/,
  /新装版/,
  /ベストセラー/,
  /不朽の名著/,
  /感動の書/,
  /内容紹介/,
  /著者略歴/,
  /^訳者$/,
  /^編者$/,
  /^著者$/,
  /^出版社$/,
  /^ISBN/,
  /^発売日$/,
  /^価格$/,
  /^目次$/,
  /^まえがき$/,
  /^あとがき$/,
  /^索引$/,
  /^参考文献$/,
  /^謝辞$/,
  /^序文$/,
  /^付録/,
  /^はじめに$/,
  /^おわりに$/,
];

const STRUCTURAL_PREFIXES = [
  /^PART\s+[IVXLCDM\d]+[\s\-:：.。]*/i,
  /^第[一二三四五六七八九十百千\d]+[章節部編][\s\-:：.。]*/,
  /^Chapter\s+\d+[\s\-:：.。]*/i,
  /^Section\s+\d+[\s\-:：.。]*/i,
  /^\d+[\s.:：]+/,
  /^[ivxlIVXL]+[.\s:：]+/,
];

function stripStructuralPrefix(line: string): string {
  let result = line.trim();
  for (const pattern of STRUCTURAL_PREFIXES) {
    result = result.replace(pattern, "").trim();
  }
  return result;
}

function isNoise(text: string): boolean {
  if (text.length < 2) return true;
  return NOISE_PATTERNS.some((p) => p.test(text));
}

function extractFromTocLine(line: string): string[] {
  const stripped = stripStructuralPrefix(line);
  if (!stripped || stripped.length < 2) return [];

  const results: string[] = [stripped];

  // "AとB" / "AおよびB" → A and B separately
  const andMatch = stripped.match(/^(.+?)(?:と|および|&)(.+)$/);
  if (andMatch) {
    results.push(andMatch[1].trim(), andMatch[2].trim());
  }

  // "Xのリスク/原則/方法/技術/…" → also X itself
  const noMatch = stripped.match(
    /^(.+?)の(リスク|原則|方法|技術|活用|理論|実践|仕組み|メカニズム|効果|影響|問題|課題|戦略|思考|法則|規則)$/
  );
  if (noMatch) {
    results.push(noMatch[1].trim());
  }

  // "AはBを高める/生む/…" → A and B
  const verbMatch = stripped.match(/^(.+?)は(.+?)を/);
  if (verbMatch) {
    results.push(verbMatch[1].trim(), verbMatch[2].trim());
  }

  return results.filter((r) => r.length >= 2 && !isNoise(r));
}

export function generateConceptCandidates({
  toc,
  subjects,
  userNotes,
}: {
  toc: string[];
  subjects: string[];
  userNotes: string;
}): ConceptCandidate[] {
  const seen = new Set<string>();
  const candidates: ConceptCandidate[] = [];

  function add(text: string, sourceType: SourceType, evidenceText: string) {
    const key = text.trim().toLowerCase();
    if (!key || key.length < 2 || seen.has(key) || isNoise(text.trim())) return;
    seen.add(key);
    candidates.push({ text: text.trim(), sourceType, evidenceText: evidenceText.trim() });
  }

  for (const line of toc) {
    const terms = extractFromTocLine(line);
    for (const term of terms) {
      add(term, "table_of_contents", line);
    }
  }

  for (const subject of subjects) {
    add(subject, "ndl_subjects", subject);
  }

  if (userNotes) {
    for (const line of userNotes.split(/[\n\r]+/)) {
      const trimmed = line.replace(/^[\s\-・•*#]+/, "").trim();
      if (trimmed.length >= 2 && !isNoise(trimmed)) {
        add(trimmed, "user_notes", trimmed);
      }
    }
  }

  return candidates;
}

export function tocLineCount(toc: string[]): number {
  return toc.filter((line) => {
    const stripped = stripStructuralPrefix(line);
    return stripped.length >= 2 && !isNoise(stripped);
  }).length;
}
