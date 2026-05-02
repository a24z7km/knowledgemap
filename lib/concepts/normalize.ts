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
    .replace(/[’'`]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9ぁ-んァ-ヶ一-龠]/g, "");
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
