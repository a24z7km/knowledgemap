import OpenAI from "openai";
import { conceptSimilarity } from "@/lib/concepts/normalize";
import { isRelationType, RELATION_TYPES, type RelationType } from "@/lib/relations";
import { chatWithRetry } from "./openai-client";
import { parseToolArgumentsArray } from "./tool-arguments";

export interface GlobalRelationConcept {
  id: number;
  name: string;
  aliases: string[];
  domain: string;
  description: string | null;
  bookCount: number;
  bookIds: number[];
  averageImportance: number;
  conceptTypes: string[];
  specificities: string[];
}

export interface ExistingRelationNeighborhood {
  fromConceptId: number;
  toConceptId: number;
}

export interface ExtractedGlobalRelation {
  fromConceptId: number;
  toConceptId: number;
  relationType: RelationType;
  evidence: string;
  confidence: number;
}

interface CandidatePair {
  a: GlobalRelationConcept;
  b: GlobalRelationConcept;
  score: number;
  reasons: string[];
}

const PAIRS_PER_CONCEPT = 10;

function buildGlobalRelationTool(maxItems: number): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: "save_global_relations",
      description: "Save global semantic relationships between concepts",
      parameters: {
        type: "object",
        properties: {
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                fromConceptId: { type: "number" },
                toConceptId: { type: "number" },
                relationType: { type: "string", enum: RELATION_TYPES },
                evidence: { type: "string" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["fromConceptId", "toConceptId", "relationType", "evidence"],
            },
            minItems: 0,
            maxItems,
          },
        },
        required: ["relations"],
      },
    },
  };
}

export async function extractGlobalRelations({
  concepts,
  existingRelations,
  model = "gpt-4o-mini",
}: {
  concepts: GlobalRelationConcept[];
  existingRelations?: ExistingRelationNeighborhood[];
  model?: string;
}): Promise<ExtractedGlobalRelation[]> {
  if (concepts.length < 2) return [];

  const candidatePairs = buildCandidatePairs(concepts, existingRelations ?? []);
  const minTarget = Math.ceil(concepts.length * 1.2);
  const target = Math.ceil(concepts.length * 1.45);
  const maxRelations = Math.ceil(concepts.length * 1.7);

  const response = await chatWithRetry({
    model,
    max_completion_tokens: 16384,
    tools: [buildGlobalRelationTool(maxRelations)],
    tool_choice: { type: "function", function: { name: "save_global_relations" } },
    messages: [
      {
        role: "system",
        content: `You are rebuilding a global knowledge graph across all concepts.

Create relation edges only when there is a meaningful semantic relationship.

Do not create an edge only because two concepts appear in the same book.
Do not create an edge only because two concepts share the same domain.
Do not create edges for mere similarity. Similarity is handled separately by the layout layer.

Valid semantic patterns:
- framework/component
- parent/child concept
- method/purpose
- problem/solution
- cause/effect
- prerequisite/application
- contrast/tradeoff
- same framework siblings

Use specific relation types whenever possible. related and same_family_as are allowed as weak semantic links, but only when a real semantic connection exists.
Target ${minTarget}-${target} relations. For ${concepts.length} concepts, do not return a sparse graph unless the candidates genuinely lack semantic connections.
Use only concept ids from the provided candidate pairs.`,
      },
      {
        role: "user",
        content: `Concepts:
${formatConcepts(concepts)}

Candidate pairs:
${formatCandidatePairs(candidatePairs)}

Return up to ${maxRelations} global semantic relations. Prefer around ${target} relations, with a minimum goal of ${minTarget} when the semantic evidence supports it.`,
      },
    ],
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    throw new Error("LLM did not return function call");
  }

  const relations = parseToolArgumentsArray<unknown>(toolCall.function.arguments, "relations");
  const conceptIds = new Set(concepts.map((concept) => concept.id));
  const candidateKeys = new Set(candidatePairs.map((pair) => pairKey(pair.a.id, pair.b.id)));
  const seen = new Set<string>();

  return relations.flatMap((value) => {
    const relation = normalizeRelation(value);
    if (!relation) return [];
    if (!conceptIds.has(relation.fromConceptId) || !conceptIds.has(relation.toConceptId)) return [];
    if (relation.fromConceptId === relation.toConceptId) return [];
    if (!candidateKeys.has(pairKey(relation.fromConceptId, relation.toConceptId))) return [];

    const key = [
      Math.min(relation.fromConceptId, relation.toConceptId),
      Math.max(relation.fromConceptId, relation.toConceptId),
      relation.relationType,
    ].join("||");
    if (seen.has(key)) return [];
    seen.add(key);
    return [relation];
  });
}

export function buildHighSimilarityFallbackRelations({
  concepts,
  existingRelations,
}: {
  concepts: GlobalRelationConcept[];
  existingRelations: ExistingRelationNeighborhood[];
}): ExtractedGlobalRelation[] {
  const connectedIds = new Set<number>();
  for (const relation of existingRelations) {
    connectedIds.add(relation.fromConceptId);
    connectedIds.add(relation.toConceptId);
  }

  const fallback: ExtractedGlobalRelation[] = [];
  for (const concept of concepts) {
    if (connectedIds.has(concept.id)) continue;
    const target = concepts
      .filter((candidate) => candidate.id !== concept.id)
      .map((candidate) => ({
        candidate,
        similarity: maxNameSimilarity(concept, candidate),
      }))
      .filter((item) => item.similarity >= 0.82)
      .sort((a, b) => b.similarity - a.similarity)[0];

    if (!target) continue;
    fallback.push({
      fromConceptId: concept.id,
      toConceptId: target.candidate.id,
      relationType: "related",
      evidence: "Heuristic fallback relation based on high name or alias similarity.",
      confidence: 0.35,
    });
    connectedIds.add(concept.id);
    connectedIds.add(target.candidate.id);
  }
  return fallback;
}

function buildCandidatePairs(
  concepts: GlobalRelationConcept[],
  existingRelations: ExistingRelationNeighborhood[]
): CandidatePair[] {
  const degreeByConceptId = new Map<number, number>();
  const neighborsByConceptId = new Map<number, Set<number>>();
  for (const relation of existingRelations) {
    degreeByConceptId.set(relation.fromConceptId, (degreeByConceptId.get(relation.fromConceptId) ?? 0) + 1);
    degreeByConceptId.set(relation.toConceptId, (degreeByConceptId.get(relation.toConceptId) ?? 0) + 1);
    getSet(neighborsByConceptId, relation.fromConceptId).add(relation.toConceptId);
    getSet(neighborsByConceptId, relation.toConceptId).add(relation.fromConceptId);
  }

  const candidatesByConceptId = new Map<number, CandidatePair[]>();
  for (let i = 0; i < concepts.length; i += 1) {
    for (let j = i + 1; j < concepts.length; j += 1) {
      const pair = scoreCandidatePair(concepts[i], concepts[j], degreeByConceptId, neighborsByConceptId);
      if (!pair) continue;
      getArray(candidatesByConceptId, concepts[i].id).push(pair);
      getArray(candidatesByConceptId, concepts[j].id).push(pair);
    }
  }

  const selected = new Map<string, CandidatePair>();
  for (const concept of concepts) {
    const top = (candidatesByConceptId.get(concept.id) ?? [])
      .sort((a, b) => b.score - a.score)
      .slice(0, PAIRS_PER_CONCEPT);
    for (const pair of top) {
      selected.set(pairKey(pair.a.id, pair.b.id), pair);
    }
  }

  return [...selected.values()].sort((a, b) => b.score - a.score);
}

function scoreCandidatePair(
  a: GlobalRelationConcept,
  b: GlobalRelationConcept,
  degreeByConceptId: Map<number, number>,
  neighborsByConceptId: Map<number, Set<number>>
): CandidatePair | null {
  const reasons: string[] = [];
  let score = 0;
  const nameScore = maxNameSimilarity(a, b);
  const descriptionScore = textSimilarity(a.description ?? "", b.description ?? "");
  const conceptTypeOverlap = overlap(a.conceptTypes, b.conceptTypes);
  const specificityOverlap = overlap(a.specificities, b.specificities);
  const domainMatch = a.domain === b.domain;
  const hubScore = Math.min(1, Math.max(a.bookCount, b.bookCount) / 5);
  const existingNeighborhoodScore = existingNeighborhood(a.id, b.id, degreeByConceptId, neighborsByConceptId);

  if (nameScore >= 0.72) {
    score += nameScore * 4;
    reasons.push(`name/alias similarity ${nameScore.toFixed(2)}`);
  }
  if (descriptionScore >= 0.16) {
    score += descriptionScore * 3;
    reasons.push(`description similarity ${descriptionScore.toFixed(2)}`);
  }
  if (conceptTypeOverlap > 0) {
    score += conceptTypeOverlap * 1.2;
    reasons.push("conceptType overlap");
  }
  if (specificityOverlap > 0) {
    score += specificityOverlap * 0.8;
    reasons.push("specificity overlap");
  }
  if (domainMatch) {
    score += 0.4;
    reasons.push("same domain");
  }
  if (hubScore > 0) {
    score += hubScore * 0.8;
    reasons.push("high bookCount concept");
  }
  if (existingNeighborhoodScore > 0) {
    score += existingNeighborhoodScore * 1.5;
    reasons.push("existing relation neighborhood");
  }

  const hasNonDomainSignal =
    nameScore >= 0.72 ||
    descriptionScore >= 0.16 ||
    conceptTypeOverlap > 0 ||
    specificityOverlap > 0 ||
    existingNeighborhoodScore > 0 ||
    hubScore >= 0.6;
  if (!hasNonDomainSignal || score < 1.2) return null;

  return { a, b, score, reasons };
}

function formatConcepts(concepts: GlobalRelationConcept[]) {
  return concepts
    .map((concept) => {
      const aliases = concept.aliases.length > 0 ? ` aliases=${concept.aliases.join("/")}` : "";
      const types = concept.conceptTypes.length > 0 ? ` types=${concept.conceptTypes.join("/")}` : "";
      const specificities = concept.specificities.length > 0 ? ` specificity=${concept.specificities.join("/")}` : "";
      return `${concept.id}: ${concept.name}${aliases} [${concept.domain}] books=${concept.bookCount} avgImportance=${concept.averageImportance.toFixed(1)}${types}${specificities} - ${concept.description ?? ""}`;
    })
    .join("\n");
}

function formatCandidatePairs(pairs: CandidatePair[]) {
  return pairs
    .map((pair) => `${pair.a.id} (${pair.a.name}) <-> ${pair.b.id} (${pair.b.name}); score=${pair.score.toFixed(2)}; signals=${pair.reasons.join(", ")}`)
    .join("\n");
}

function normalizeRelation(value: unknown): ExtractedGlobalRelation | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const fromConceptId = numberValue(input.fromConceptId);
  const toConceptId = numberValue(input.toConceptId);
  const relationType = stringValue(input.relationType);
  const evidence = stringValue(input.evidence);
  const confidence = numberValue(input.confidence);
  if (fromConceptId == null || toConceptId == null || !isRelationType(relationType) || !evidence) return null;
  return {
    fromConceptId,
    toConceptId,
    relationType,
    evidence,
    confidence: clamp(confidence ?? 0.5, 0, 1),
  };
}

function maxNameSimilarity(a: GlobalRelationConcept, b: GlobalRelationConcept) {
  const left = [a.name, ...a.aliases];
  const right = [b.name, ...b.aliases];
  let max = 0;
  for (const l of left) {
    for (const r of right) {
      max = Math.max(max, conceptSimilarity(l, r));
    }
  }
  return max;
}

function textSimilarity(a: string, b: string) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / Math.max(left.size, right.size);
}

function tokenSet(value: string) {
  const stopWords = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "about", "する", "こと", "ため"]);
  return new Set(
    value
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^a-z0-9ぁ-んァ-ヶ一-龠]+/)
      .filter((token) => token.length >= 3 && !stopWords.has(token))
  );
}

function overlap(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).length / Math.max(left.length, right.length);
}

function existingNeighborhood(
  aId: number,
  bId: number,
  degreeByConceptId: Map<number, number>,
  neighborsByConceptId: Map<number, Set<number>>
) {
  const aNeighbors = neighborsByConceptId.get(aId);
  const bNeighbors = neighborsByConceptId.get(bId);
  const degreeScore = Math.min(1, ((degreeByConceptId.get(aId) ?? 0) + (degreeByConceptId.get(bId) ?? 0)) / 12);
  if (!aNeighbors || !bNeighbors) return degreeScore * 0.25;

  let shared = 0;
  for (const neighbor of aNeighbors) {
    if (bNeighbors.has(neighbor)) shared += 1;
  }
  return Math.min(1, shared / 3 + degreeScore * 0.25);
}

function pairKey(a: number, b: number) {
  return `${Math.min(a, b)}||${Math.max(a, b)}`;
}

function getSet<K, V>(map: Map<K, Set<V>>, key: K) {
  let value = map.get(key);
  if (!value) {
    value = new Set<V>();
    map.set(key, value);
  }
  return value;
}

function getArray<K, V>(map: Map<K, V[]>, key: K) {
  let value = map.get(key);
  if (!value) {
    value = [];
    map.set(key, value);
  }
  return value;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
