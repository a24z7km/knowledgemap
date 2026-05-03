const KATAKANA_ROMAJI: Record<string, string> = {
  ア: "a",
  イ: "i",
  ウ: "u",
  エ: "e",
  オ: "o",
  カ: "ka",
  キ: "ki",
  ク: "ku",
  ケ: "ke",
  コ: "ko",
  サ: "sa",
  シ: "shi",
  ス: "su",
  セ: "se",
  ソ: "so",
  タ: "ta",
  チ: "chi",
  ツ: "tsu",
  テ: "te",
  ト: "to",
  ナ: "na",
  ニ: "ni",
  ヌ: "nu",
  ネ: "ne",
  ノ: "no",
  ハ: "ha",
  ヒ: "hi",
  フ: "fu",
  ヘ: "he",
  ホ: "ho",
  マ: "ma",
  ミ: "mi",
  ム: "mu",
  メ: "me",
  モ: "mo",
  ヤ: "ya",
  ユ: "yu",
  ヨ: "yo",
  ラ: "ra",
  リ: "ri",
  ル: "ru",
  レ: "re",
  ロ: "ro",
  ワ: "wa",
  ヲ: "wo",
  ン: "n",
  ガ: "ga",
  ギ: "gi",
  グ: "gu",
  ゲ: "ge",
  ゴ: "go",
  ザ: "za",
  ジ: "ji",
  ズ: "zu",
  ゼ: "ze",
  ゾ: "zo",
  ダ: "da",
  ヂ: "ji",
  ヅ: "zu",
  デ: "de",
  ド: "do",
  バ: "ba",
  ビ: "bi",
  ブ: "bu",
  ベ: "be",
  ボ: "bo",
  パ: "pa",
  ピ: "pi",
  プ: "pu",
  ペ: "pe",
  ポ: "po",
  ヴ: "v",
  ァ: "a",
  ィ: "i",
  ゥ: "u",
  ェ: "e",
  ォ: "o",
};

const DIGRAPH_ROMAJI: Record<string, string> = {
  キャ: "kya",
  キュ: "kyu",
  キョ: "kyo",
  シャ: "sha",
  シュ: "shu",
  ショ: "sho",
  チャ: "cha",
  チュ: "chu",
  チョ: "cho",
  ニャ: "nya",
  ニュ: "nyu",
  ニョ: "nyo",
  ヒャ: "hya",
  ヒュ: "hyu",
  ヒョ: "hyo",
  ミャ: "mya",
  ミュ: "myu",
  ミョ: "myo",
  リャ: "rya",
  リュ: "ryu",
  リョ: "ryo",
  ギャ: "gya",
  ギュ: "gyu",
  ギョ: "gyo",
  ジャ: "ja",
  ジュ: "ju",
  ジョ: "jo",
  ビャ: "bya",
  ビュ: "byu",
  ビョ: "byo",
  ピャ: "pya",
  ピュ: "pyu",
  ピョ: "pyo",
  ファ: "fa",
  フィ: "fi",
  フェ: "fe",
  フォ: "fo",
  ウィ: "wi",
  ウェ: "we",
  ウォ: "wo",
  ヴァ: "va",
  ヴィ: "vi",
  ヴェ: "ve",
  ヴォ: "vo",
};

export function normalizeConceptKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ぁ-ん]+$/g, "")
    .replace(/[’'`]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9ぁ-んァ-ヶ一-龠]/g, "");
}

export interface ConceptClusterInput {
  name: string;
  nameJa?: string | null;
}

export interface ConceptCluster<T extends ConceptClusterInput> {
  representative: string;
  representativeJa: string | null;
  items: T[];
  frequency: number;
}

export function clusterConceptCandidates<T extends ConceptClusterInput>(
  candidates: T[],
  threshold = 0.85
): ConceptCluster<T>[] {
  const clusters: ConceptCluster<T>[] = [];

  for (const candidate of candidates) {
    const candidateKey = normalizeConceptKey(candidate.name);
    const candidateJaKey = normalizeConceptKey(candidate.nameJa ?? "");
    if (!candidateKey && !candidateJaKey) continue;

    const target = clusters.find((cluster) =>
      cluster.items.some((item) => {
        const itemKey = normalizeConceptKey(item.name);
        const itemJaKey = normalizeConceptKey(item.nameJa ?? "");
        return (
          isSimilarConceptKey(candidateKey, itemKey, threshold) ||
          isSimilarConceptKey(candidateJaKey, itemJaKey, threshold) ||
          (candidateKey && itemJaKey && isSimilarConceptKey(candidateKey, itemJaKey, threshold)) ||
          (candidateJaKey && itemKey && isSimilarConceptKey(candidateJaKey, itemKey, threshold))
        );
      })
    );

    if (target) {
      target.items.push(candidate);
      target.frequency = target.items.length;
      target.representative = chooseRepresentative(target.items, "name") ?? target.representative;
      target.representativeJa = chooseRepresentative(target.items, "nameJa");
    } else {
      clusters.push({
        representative: candidate.name,
        representativeJa: candidate.nameJa ?? null,
        items: [candidate],
        frequency: 1,
      });
    }
  }

  return clusters;
}

export function conceptSimilarity(a: string, b: string): number {
  const left = normalizeConceptKey(a);
  const right = normalizeConceptKey(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const distance = levenshteinDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

export function conceptLookupKeys(...values: Array<string | null | undefined>): string[] {
  const keys = new Set<string>();

  for (const value of values) {
    if (!value) continue;
    const normalized = normalizeConceptKey(value);
    if (normalized) keys.add(normalized);

    const romaji = katakanaToRomaji(value);
    if (romaji) keys.add(normalizeConceptKey(romaji));
  }

  return [...keys];
}

export function parseAliases(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function mergeAliases(existingAliases: string[], ...nextAliases: Array<string | null | undefined>): string[] {
  const aliases = new Map(existingAliases.map((alias) => [normalizeConceptKey(alias), alias]));
  for (const alias of nextAliases) {
    if (!alias) continue;
    const key = normalizeConceptKey(alias);
    if (key) aliases.set(key, alias);
  }
  return [...aliases.values()];
}

function katakanaToRomaji(value: string): string | null {
  const chars = [...value.normalize("NFKC")];
  let output = "";
  let hasKatakana = false;

  for (let i = 0; i < chars.length; i++) {
    const current = chars[i];
    const next = chars[i + 1] ?? "";

    if (current === "ッ") {
      const nextPair = DIGRAPH_ROMAJI[next + (chars[i + 2] ?? "")];
      const nextRoman = nextPair ?? KATAKANA_ROMAJI[next];
      if (nextRoman) output += nextRoman[0];
      hasKatakana = true;
      continue;
    }

    if (current === "ー") {
      output += output.at(-1) ?? "";
      hasKatakana = true;
      continue;
    }

    const pair = DIGRAPH_ROMAJI[current + next];
    if (pair) {
      output += pair;
      hasKatakana = true;
      i++;
      continue;
    }

    const roman = KATAKANA_ROMAJI[current];
    if (roman) {
      output += roman;
      hasKatakana = true;
    } else if (/[a-zA-Z0-9]/.test(current)) {
      output += current;
    }
  }

  return hasKatakana ? output : null;
}

function isSimilarConceptKey(a: string, b: string, threshold: number) {
  if (!a || !b) return false;
  if (a === b) return true;
  const distance = levenshteinDistance(a, b);
  const similarity = 1 - distance / Math.max(a.length, b.length);
  return similarity >= threshold;
}

function levenshteinDistance(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0) as number[]);

  for (let i = 0; i <= left.length; i++) dp[i][0] = i;
  for (let j = 0; j <= right.length; j++) dp[0][j] = j;

  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[left.length][right.length];
}

function chooseRepresentative<T extends ConceptClusterInput>(items: T[], key: "name" | "nameJa"): string | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = item[key]?.trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => {
    const countDiff = b[1] - a[1];
    if (countDiff !== 0) return countDiff;
    return a[0].length - b[0].length;
  });

  return ranked[0]?.[0] ?? null;
}
