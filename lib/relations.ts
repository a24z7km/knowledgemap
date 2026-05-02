export const RELATION_TYPES = [
  "prerequisite",
  "related",
  "contradicts",
  "extends",
  "applies_to",
  "same_family_as",
  "operationalizes",
  "supports",
  "contrasts_with",
  "example_of",
  "reframes",
  "mitigates",
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

export const RELATION_LABELS: Record<RelationType, { label: string; color: string; dash?: string }> = {
  prerequisite: { label: "前提", color: "#f97316" },
  related: { label: "関連", color: "#94a3b8" },
  contradicts: { label: "矛盾", color: "#ef4444", dash: "4 2" },
  extends: { label: "拡張", color: "#8b5cf6" },
  applies_to: { label: "適用", color: "#10b981", dash: "1 2" },
  same_family_as: { label: "同系統", color: "#0ea5e9" },
  operationalizes: { label: "具体化", color: "#14b8a6" },
  supports: { label: "支持", color: "#84cc16" },
  contrasts_with: { label: "対比", color: "#f43f5e", dash: "5 3" },
  example_of: { label: "例示", color: "#06b6d4", dash: "2 2" },
  reframes: { label: "再解釈", color: "#6366f1" },
  mitigates: { label: "緩和", color: "#22c55e", dash: "6 2" },
};

export function isRelationType(value: string): value is RelationType {
  return (RELATION_TYPES as readonly string[]).includes(value);
}

export function relationLabel(value: string): string {
  return isRelationType(value) ? RELATION_LABELS[value].label : value;
}

export function relationColor(value: string): string {
  return isRelationType(value) ? RELATION_LABELS[value].color : "#94a3b8";
}

export function relationDash(value: string): string | undefined {
  return isRelationType(value) ? RELATION_LABELS[value].dash : undefined;
}

export function relationLineStyle(value: string): "solid" | "dashed" | "dotted" {
  const dash = relationDash(value);
  if (dash === "1 2" || dash === "2 2") return "dotted";
  if (dash) return "dashed";
  return "solid";
}
