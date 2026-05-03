export interface RelationEvidenceConcept {
  name: string;
  aliases?: string[];
}

export function isValidRelationEvidence(
  evidence: string | null | undefined,
  source: RelationEvidenceConcept,
  target: RelationEvidenceConcept,
  sourceTexts: Array<string | null | undefined> = []
): boolean {
  const normalizedEvidence = normalizeEvidenceText(evidence ?? "");
  if (normalizedEvidence.length < 20) return false;

  const normalizedSourceTexts = sourceTexts.map((value) => normalizeEvidenceText(value ?? ""));
  if (normalizedSourceTexts.length > 0 && !normalizedSourceTexts.some((text) => text.includes(normalizedEvidence))) {
    return false;
  }

  return [...relationEvidenceTerms(source), ...relationEvidenceTerms(target)].some((term) =>
    normalizedEvidence.includes(term)
  );
}

export function relationEvidenceText(...values: Array<string | null | undefined>): string {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value)) ?? "";
}

function relationEvidenceTerms(concept: RelationEvidenceConcept): string[] {
  return [concept.name, ...(concept.aliases ?? [])]
    .map(normalizeEvidenceText)
    .filter((term) => term.length > 0);
}

function normalizeEvidenceText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}
