import { type ExtractionCategory, type GroundingType } from "@/lib/concept-metadata";
import { clusterConceptCandidates, normalizeConceptKey } from "./normalize";

export interface ScoreableConcept {
  name: string;
  nameJa?: string | null;
  category: ExtractionCategory;
  groundingType: GroundingType;
  importance: number;
  specificityScore: number;
  confidence: number;
}

export interface ScoredConcept<T extends ScoreableConcept> {
  concept: T;
  finalScore: number;
  status: "promoted" | "candidate" | "rejected";
  frequency: number;
  droppedReason: string | null;
}

const GENERIC_BLOCKLIST = new Set([
  "success",
  "growth",
  "leadership",
  "motivation",
  "productivity",
  "selfimprovement",
  "management",
  "happiness",
  "purpose",
  "selfmanagement",
  "selfdiscipline",
  "willpower",
  "decisionmaking",
  "goalsetting",
  "timemanagement",
  "responsibility",
  "personalgrowth",
  "lifevision",
  "lifeprinciples",
  "continuousimprovement",
  "changemanagement",
  "habitformation",
  "prioritization",
  "成功",
  "成長",
  "リーダーシップ",
  "モチベーション",
  "生産性",
  "自己啓発",
  "幸福",
  "目的",
  "自己管理",
  "自己規律",
  "意志力",
  "意思決定",
  "目標設定",
  "時間管理",
  "責任",
  "個人成長",
  "人生ビジョン",
  "人生の原則",
  "継続的改善",
  "変革管理",
  "習慣形成",
  "優先順位付け",
]);

const GROUNDING_WEIGHTS: Record<GroundingType, number> = {
  source_explicit: 1.0,
  source_supported: 0.7,
  metadata_only: 0.4,
  model_prior: 0.2,
};

const CATEGORY_WEIGHTS: Record<ExtractionCategory, number> = {
  framework: 1.0,
  component: 0.9,
  practice: 0.8,
  thesis: 0.7,
  outcome: 0.5,
  context: 0.3,
};

export function scoreConceptCandidates<T extends ScoreableConcept>(concepts: T[]): ScoredConcept<T>[] {
  const clusters = clusterConceptCandidates(concepts);
  const maxFrequency = Math.max(1, ...clusters.map((cluster) => cluster.frequency));
  const scored: ScoredConcept<T>[] = clusters.map((cluster) => {
    const concept = chooseBestClusterItem(cluster.items, cluster.frequency / maxFrequency);
    const droppedReason = blocklistReason(concept);
    return {
      concept,
      finalScore: droppedReason ? 0 : calculateFinalScore(concept, cluster.frequency / maxFrequency),
      status: droppedReason ? "rejected" : "candidate",
      frequency: cluster.frequency,
      droppedReason,
    };
  });

  const eligible = scored
    .filter((item) => item.status !== "rejected")
    .sort((a, b) => b.finalScore - a.finalScore);
  const promoted = eligible
    .filter((item) => item.finalScore >= 0.5)
    .slice(0, 30);
  const promotedSet = new Set(promoted);

  return scored
    .map((item) => {
      if (item.status === "rejected") return item;
      return {
        ...item,
        status: promotedSet.has(item) ? "promoted" as const : "candidate" as const,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

export function calculateFinalScore(concept: ScoreableConcept, frequencyNormalized: number): number {
  return (
    0.30 * GROUNDING_WEIGHTS[concept.groundingType] +
    0.25 * clamp01(concept.importance / 5) +
    0.15 * clamp01(concept.specificityScore / 5) +
    0.20 * clamp01(frequencyNormalized) +
    0.10 * CATEGORY_WEIGHTS[concept.category]
  );
}

function chooseBestClusterItem<T extends ScoreableConcept>(items: T[], frequencyNormalized: number): T {
  return [...items].sort((a, b) => calculateFinalScore(b, frequencyNormalized) - calculateFinalScore(a, frequencyNormalized))[0];
}

function blocklistReason(concept: ScoreableConcept): string | null {
  const keys = [normalizeConceptKey(concept.name), normalizeConceptKey(concept.nameJa ?? "")].filter(Boolean);
  return keys.some((key) => GENERIC_BLOCKLIST.has(key)) ? "generic_blocklist" : null;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
