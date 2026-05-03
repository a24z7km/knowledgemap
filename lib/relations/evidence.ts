export interface RelationEvidenceConcept {
  name: string;
  aliases?: string[];
}

export function isValidRelationEvidence(
  evidence: string | null | undefined,
  _source: RelationEvidenceConcept,
  _target: RelationEvidenceConcept,
  _sourceTexts: Array<string | null | undefined> = []
): boolean {
  const normalizedEvidence = normalizeEvidenceText(evidence ?? "");
  if (normalizedEvidence.length < 20) return false;
  return true;
}

export function relationEvidenceText(...values: Array<string | null | undefined>): string {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value)) ?? "";
}

function normalizeEvidenceText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}
