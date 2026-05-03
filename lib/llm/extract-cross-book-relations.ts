import OpenAI from "openai";
import { isRelationType, RELATION_TYPES, type RelationType } from "@/lib/relations";
import { chatWithRetry } from "./openai-client";
import { isValidRelationEvidence } from "@/lib/relations/evidence";

export interface CrossBookConcept {
  id: number;
  name: string;
  aliases?: string[];
  domain: string;
  description: string | null;
  importance?: number;
  excerpt?: string | null;
  books?: { id: number; title: string; author: string; importance?: number; excerpt?: string | null }[];
}

export interface CrossBookRelationContext {
  from: string;
  to: string;
  relationType: string;
  evidence: string | null;
  bookTitle?: string | null;
}

export interface ExtractedCrossBookRelation {
  from: string;
  to: string;
  relationType: RelationType;
  evidence: string;
  weight: number;
  reason: string;
  confidence: number;
}

function buildCrossBookRelationTool(maxItems: number): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: "save_cross_book_relations",
      description: "Save cross-book relationships between newly analyzed concepts and existing concepts",
      parameters: {
        type: "object",
        properties: {
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "string", description: "Source concept name, exact match from the provided concepts" },
                to: { type: "string", description: "Target concept name, exact match from the provided concepts" },
                relationType: {
                  type: "string",
                  enum: RELATION_TYPES,
                  description:
                    "Use the most specific type. related is a last resort only. Prefer cross-book conceptual bridges that help navigation.",
                },
                evidence: { type: "string", description: "Short evidence grounded in the concept descriptions and book appearances" },
                weight: { type: "number", minimum: 0.1, maximum: 1 },
                reason: { type: "string", description: "Why this cross-book edge improves the knowledge map" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["from", "to", "relationType", "evidence", "weight", "reason", "confidence"],
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

export async function extractCrossBookRelations({
  newConcepts,
  existingConcepts,
  existingRelations,
  title,
  author,
  model = "gpt-4o-mini",
}: {
  newConcepts: CrossBookConcept[];
  existingConcepts: CrossBookConcept[];
  existingRelations: CrossBookRelationContext[];
  title: string;
  author: string;
  model?: string;
}): Promise<ExtractedCrossBookRelation[]> {
  if (newConcepts.length === 0 || existingConcepts.length === 0) return [];

  const maxRelations = Math.min(newConcepts.length * 3, 60);
  const response = await chatWithRetry({
    model,
    max_completion_tokens: 8192,
    tools: [buildCrossBookRelationTool(maxRelations)],
    tool_choice: { type: "function", function: { name: "save_cross_book_relations" } },
    messages: [
      {
        role: "system",
        content: `You are connecting a reading knowledge graph across books.

Create only high-signal cross-book relationships between concepts from the newly analyzed book and concepts that appeared in earlier books.

Rules:
- Each relationship must connect one NEW concept to one EXISTING concept.
- Do not prioritize relationships between concepts from the same new book.
- Create at most 0-3 relationships per NEW concept. It is fine to create none.
- Prefer specific relation types over related. Use related only when the edge is useful and no precise type applies.
- Avoid generic edges such as two concepts merely sharing a broad domain.
- Avoid duplicates or near-duplicates of existing relationships.
- Save only relationships with confidence >= 0.65.
- Use weight 0.3-1.0 based on strength and usefulness.
- Use exact concept names from the input.
- Evidence must be copied from one provided book excerpt and must include one endpoint concept name or alias.`,
      },
      {
        role: "user",
        content: `Newly analyzed book:
${title} — ${author}

NEW concepts:
${formatConcepts(newConcepts)}

EXISTING concepts from other books:
${formatConcepts(existingConcepts)}

Existing relation examples:
${formatRelations(existingRelations)}

Return up to ${maxRelations} cross-book relationships that would make the map feel connected but not cluttered.`,
      },
    ],
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    throw new Error("LLM did not return function call");
  }

  const input = JSON.parse(toolCall.function.arguments) as { relations?: unknown[] };
  const newNames = new Set(newConcepts.map((concept) => concept.name));
  const existingNames = new Set(existingConcepts.map((concept) => concept.name));
  const conceptByName = new Map([...newConcepts, ...existingConcepts].map((concept) => [concept.name, concept]));
  const seen = new Set<string>();
  const perNewConcept = new Map<string, number>();

  return (input.relations ?? []).flatMap((value) => {
    const relation = normalizeRelation(value);
    if (!relation || relation.confidence < 0.65) return [];

    const fromIsNew = newNames.has(relation.from);
    const toIsNew = newNames.has(relation.to);
    const fromIsExisting = existingNames.has(relation.from);
    const toIsExisting = existingNames.has(relation.to);
    if (!((fromIsNew && toIsExisting) || (toIsNew && fromIsExisting))) return [];
    const fromConcept = conceptByName.get(relation.from);
    const toConcept = conceptByName.get(relation.to);
    if (!fromConcept || !toConcept) return [];
    if (!isValidRelationEvidence(
      relation.evidence,
      { name: fromConcept.name, aliases: fromConcept.aliases ?? [] },
      { name: toConcept.name, aliases: toConcept.aliases ?? [] },
      [
        fromConcept.excerpt,
        ...(fromConcept.books?.map((book) => book.excerpt) ?? []),
        toConcept.excerpt,
        ...(toConcept.books?.map((book) => book.excerpt) ?? []),
      ]
    )) {
      return [];
    }

    const newConceptName = fromIsNew ? relation.from : relation.to;
    const count = perNewConcept.get(newConceptName) ?? 0;
    if (count >= 3) return [];

    const key = `${relation.from}||${relation.to}||${relation.relationType}`;
    if (seen.has(key)) return [];
    seen.add(key);
    perNewConcept.set(newConceptName, count + 1);
    return [relation];
  });
}

function normalizeRelation(value: unknown): ExtractedCrossBookRelation | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const from = stringValue(input.from);
  const to = stringValue(input.to);
  const relationType = stringValue(input.relationType);
  const evidence = stringValue(input.evidence);
  const reason = stringValue(input.reason);
  const weight = numberValue(input.weight);
  const confidence = numberValue(input.confidence);

  if (!from || !to || from === to || !evidence || !reason) return null;
  return {
    from,
    to,
    relationType: isRelationType(relationType) ? relationType : "related",
    evidence,
    weight: clamp(weight ?? confidence ?? 0.5, 0.1, 1),
    reason,
    confidence: clamp(confidence ?? 0, 0, 1),
  };
}

function formatConcepts(concepts: CrossBookConcept[]) {
  return concepts
    .map((concept) => {
      const aliases = concept.aliases?.length ? ` aliases: ${concept.aliases.join(" / ")}` : "";
      const books = concept.books?.length
        ? ` books: ${concept.books.map((book) => `${book.title} (${book.author}) excerpt: ${book.excerpt ?? ""}`).join("; ")}`
        : "";
      const importance = concept.importance ? ` importance ${concept.importance}/5` : "";
      const excerpt = concept.excerpt ? ` excerpt: ${concept.excerpt}` : "";
      return `- ${concept.name} [${concept.domain}]${importance}${aliases}: ${concept.description ?? "No description"}${excerpt}${books}`;
    })
    .join("\n");
}

function formatRelations(relations: CrossBookRelationContext[]) {
  if (relations.length === 0) return "(none)";
  return relations
    .map((relation) => {
      const source = relation.bookTitle ? ` in ${relation.bookTitle}` : "";
      return `- ${relation.from} -> ${relation.to} (${relation.relationType})${source}: ${relation.evidence ?? ""}`;
    })
    .join("\n");
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
