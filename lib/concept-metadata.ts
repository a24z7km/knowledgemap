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

export const EXTRACTION_CATEGORIES = ["thesis", "framework", "component", "practice", "outcome", "context"] as const;
export type ExtractionCategory = (typeof EXTRACTION_CATEGORIES)[number];

export const GROUNDING_TYPES = ["source_explicit", "source_supported", "metadata_only", "model_prior"] as const;
export type GroundingType = (typeof GROUNDING_TYPES)[number];

export const CONCEPT_STATUSES = ["promoted", "candidate", "rejected"] as const;
export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];

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

export const EXTRACTION_CATEGORY_LABELS: Record<ExtractionCategory, string> = {
  thesis: "主張",
  framework: "枠組み",
  component: "構成要素",
  practice: "実践",
  outcome: "成果",
  context: "文脈",
};

export const GROUNDING_TYPE_LABELS: Record<GroundingType, string> = {
  source_explicit: "明示",
  source_supported: "資料支持",
  metadata_only: "書誌のみ",
  model_prior: "モデル推定",
};

export const CONCEPT_STATUS_LABELS: Record<ConceptStatus, string> = {
  promoted: "採用",
  candidate: "候補",
  rejected: "却下",
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

export function extractionCategoryLabel(category?: string | null): string | null {
  return category && category in EXTRACTION_CATEGORY_LABELS
    ? EXTRACTION_CATEGORY_LABELS[category as ExtractionCategory]
    : null;
}

export function groundingTypeLabel(groundingType?: string | null): string | null {
  return groundingType && groundingType in GROUNDING_TYPE_LABELS
    ? GROUNDING_TYPE_LABELS[groundingType as GroundingType]
    : null;
}

export function conceptStatusLabel(status?: string | null): string | null {
  return status && status in CONCEPT_STATUS_LABELS ? CONCEPT_STATUS_LABELS[status as ConceptStatus] : null;
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
