export const CONCEPT_LEVELS = ["core", "supporting", "application", "outcome", "context"] as const;
export type ConceptLevel = (typeof CONCEPT_LEVELS)[number];

export const CONCEPT_TYPES = [
  "theory",
  "model",
  "framework",
  "principle",
  "technical_term",
  "mechanism",
  "method",
  "practice",
  "distinction",
  "metric",
  "institution",
  "person",
  "event",
  "phenomenon",
  "outcome",
  "theme",
] as const;
export type ConceptType = (typeof CONCEPT_TYPES)[number];

export const SPECIFICITY_LEVELS = ["book_specific", "domain_specific", "generic"] as const;
export type Specificity = (typeof SPECIFICITY_LEVELS)[number];

export const CONCEPT_LEVEL_LABELS: Record<ConceptLevel, string> = {
  core: "中核",
  supporting: "補助",
  application: "実践",
  outcome: "成果",
  context: "背景",
};

export const CONCEPT_TYPE_LABELS: Record<ConceptType, string> = {
  theory: "理論",
  model: "モデル",
  framework: "フレームワーク",
  principle: "原則",
  technical_term: "専門用語",
  mechanism: "メカニズム",
  method: "方法",
  practice: "実践",
  distinction: "区別",
  metric: "指標",
  institution: "制度",
  person: "人物",
  event: "出来事",
  phenomenon: "現象",
  outcome: "成果",
  theme: "テーマ",
};

export const SPECIFICITY_LABELS: Record<Specificity, string> = {
  book_specific: "本固有",
  domain_specific: "分野固有",
  generic: "汎用",
};

export function conceptLevelLabel(level?: string | null): string | null {
  return level && level in CONCEPT_LEVEL_LABELS ? CONCEPT_LEVEL_LABELS[level as ConceptLevel] : null;
}

export function conceptTypeLabel(type?: string | null): string | null {
  return type && type in CONCEPT_TYPE_LABELS ? CONCEPT_TYPE_LABELS[type as ConceptType] : null;
}

export function specificityLabel(specificity?: string | null): string | null {
  return specificity && specificity in SPECIFICITY_LABELS ? SPECIFICITY_LABELS[specificity as Specificity] : null;
}

export function conceptMetadataLabels({
  conceptLevel,
  conceptType,
  specificity,
}: {
  conceptLevel?: string | null;
  conceptType?: string | null;
  specificity?: string | null;
}): string[] {
  return [
    conceptLevelLabel(conceptLevel),
    conceptTypeLabel(conceptType),
    specificityLabel(specificity),
  ].filter((label): label is string => Boolean(label));
}
