import type { Concept } from "@/lib/db/schema";

export interface ConceptDuplicateCandidate {
  conceptIdA: number;
  conceptIdB: number;
  matchReason: string;
}

export interface ConceptDiagnosticInput {
  id: number;
  name: string;
  nameJa?: string | null;
  aliases?: string[] | string | null;
}

export function normalizeDiagnosticConceptText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/g, " ");
}

export function findDuplicateConceptCandidates(
  concepts: ConceptDiagnosticInput[]
): ConceptDuplicateCandidate[] {
  const candidates: ConceptDuplicateCandidate[] = [];

  for (let i = 0; i < concepts.length; i += 1) {
    for (let j = i + 1; j < concepts.length; j += 1) {
      const left = conceptDiagnosticFields(concepts[i]);
      const right = conceptDiagnosticFields(concepts[j]);
      const reason = duplicateMatchReason(left, right);
      if (!reason) continue;

      candidates.push({
        conceptIdA: concepts[i].id,
        conceptIdB: concepts[j].id,
        matchReason: reason,
      });
    }
  }

  return candidates;
}

export function conceptDiagnosticInputFromConcept(concept: Concept): ConceptDiagnosticInput {
  return {
    id: concept.id,
    name: concept.name,
    aliases: concept.aliases,
  };
}

function duplicateMatchReason(
  left: ReturnType<typeof conceptDiagnosticFields>,
  right: ReturnType<typeof conceptDiagnosticFields>
): string | null {
  for (const leftField of left.allFields) {
    if (!leftField.value) continue;
    const match = right.allFields.find((rightField) => rightField.value && rightField.value === leftField.value);
    if (match) return `${leftField.label} matches ${match.label}`;
  }

  for (const nameField of left.nameFields) {
    if (nameField.value && right.aliases.has(nameField.value)) {
      return `${nameField.label} appears in aliases`;
    }
  }

  for (const nameField of right.nameFields) {
    if (nameField.value && left.aliases.has(nameField.value)) {
      return `${nameField.label} appears in aliases`;
    }
  }

  return null;
}

function conceptDiagnosticFields(concept: ConceptDiagnosticInput) {
  const aliases = parseDiagnosticAliases(concept.aliases);
  const nameFields = [
    { label: "name", value: normalizeDiagnosticConceptText(concept.name) },
    { label: "nameJa", value: normalizeDiagnosticConceptText(concept.nameJa ?? "") },
  ].filter((field) => field.value.length > 0);
  const aliasFields = aliases
    .map((alias) => ({ label: "alias", value: normalizeDiagnosticConceptText(alias) }))
    .filter((field) => field.value.length > 0);

  return {
    nameFields,
    aliases: new Set(aliasFields.map((field) => field.value)),
    allFields: [...nameFields, ...aliasFields],
  };
}

function parseDiagnosticAliases(value: ConceptDiagnosticInput["aliases"]): string[] {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
