export const CONCEPT_DOMAINS = [
  "thinking",
  "self_management",
  "communication",
  "decision_making",
  "mindfulness",
  "ethics",
  "critical_thinking",
  "productivity",
  "learning",
  "psychology",
  "business",
  "cybersec",
  "finance",
  "law",
  "cs",
  "math",
  "general",
] as const;

export type ConceptDomain = (typeof CONCEPT_DOMAINS)[number];

export const DOMAIN_LABELS: Record<"all" | ConceptDomain, string> = {
  all: "全ドメイン",
  thinking: "思考",
  self_management: "自己管理",
  communication: "コミュニケーション",
  decision_making: "意思決定",
  mindfulness: "マインドフルネス",
  ethics: "倫理",
  critical_thinking: "批判的思考",
  productivity: "生産性",
  learning: "学習",
  psychology: "心理",
  business: "ビジネス",
  cybersec: "セキュリティ",
  finance: "金融",
  law: "法学",
  cs: "CS",
  math: "数学",
  general: "一般",
};

export const DOMAIN_COLORS: Record<ConceptDomain, string> = {
  thinking: "#0f766e",
  self_management: "#22c55e",
  communication: "#f97316",
  decision_making: "#2563eb",
  mindfulness: "#14b8a6",
  ethics: "#7c3aed",
  critical_thinking: "#dc2626",
  productivity: "#ca8a04",
  learning: "#0891b2",
  psychology: "#db2777",
  business: "#4f46e5",
  cybersec: "#ef4444",
  finance: "#16a34a",
  law: "#3b82f6",
  cs: "#a855f7",
  math: "#eab308",
  general: "#6b7280",
};

export const DOMAIN_BADGE_CLASSES: Record<ConceptDomain, string> = {
  thinking: "bg-teal-100 text-teal-800",
  self_management: "bg-green-100 text-green-800",
  communication: "bg-orange-100 text-orange-800",
  decision_making: "bg-blue-100 text-blue-800",
  mindfulness: "bg-cyan-100 text-cyan-800",
  ethics: "bg-violet-100 text-violet-800",
  critical_thinking: "bg-red-100 text-red-800",
  productivity: "bg-yellow-100 text-yellow-800",
  learning: "bg-sky-100 text-sky-800",
  psychology: "bg-pink-100 text-pink-800",
  business: "bg-indigo-100 text-indigo-800",
  cybersec: "bg-red-100 text-red-800",
  finance: "bg-green-100 text-green-800",
  law: "bg-blue-100 text-blue-800",
  cs: "bg-purple-100 text-purple-800",
  math: "bg-yellow-100 text-yellow-800",
  general: "bg-gray-100 text-gray-800",
};

export function domainLabel(domain: string): string {
  return domain in DOMAIN_LABELS ? DOMAIN_LABELS[domain as "all" | ConceptDomain] : domain;
}

export function domainColor(domain: string): string {
  return domain in DOMAIN_COLORS ? DOMAIN_COLORS[domain as ConceptDomain] : DOMAIN_COLORS.general;
}

export function domainBadgeClass(domain: string): string {
  return domain in DOMAIN_BADGE_CLASSES
    ? DOMAIN_BADGE_CLASSES[domain as ConceptDomain]
    : DOMAIN_BADGE_CLASSES.general;
}
