import OpenAI from "openai";
import type { ExtractedConcept } from "./extract-concepts";
import { isRelationType, RELATION_TYPES, type RelationType } from "@/lib/relations";
import { chatWithRetry } from "./openai-client";
import { isValidRelationEvidence } from "@/lib/relations/evidence";

export interface ExtractedRelation {
  from: string;
  to: string;
  type: RelationType;
  evidence: string;
  confidence: number;
  source?: "llm" | "fallback";
}

function buildRelationTool(minItems: number, maxItems: number): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: "save_relations",
      description: "Save extracted relationships between concepts",
      parameters: {
        type: "object",
        properties: {
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "string", description: "Source concept name (exact match from list)" },
                to: { type: "string", description: "Target concept name (exact match from list)" },
                type: {
                  type: "string",
                  enum: RELATION_TYPES,
                  description:
                    "prerequisite: A must be understood before B; same_family_as: A and B are sibling concepts in the same family/framework; operationalizes: A turns B into a concrete practice/tool; supports: A provides evidence or reinforcement for B; contrasts_with: A and B illuminate a meaningful difference; contradicts: A and B conflict; extends: B builds on A; applies_to: A is applied in context of B; example_of: A is an example/instance of B; reframes: A changes how B is interpreted; mitigates: A reduces a risk/problem in B; related: only when no more specific type fits",
                },
                evidence: { type: "string", description: "Brief justification for this relationship" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["from", "to", "type", "evidence", "confidence"],
            },
            minItems,
            maxItems,
          },
        },
        required: ["relations"],
      },
    },
  };
}

export async function extractRelations(
  title: string,
  concepts: ExtractedConcept[],
  model = "gpt-4o-mini"
): Promise<ExtractedRelation[]> {
  const minRelations = Math.max(concepts.length, Math.ceil(concepts.length * 1.5));
  const maxRelations = Math.max(minRelations, concepts.length * 3);
  const conceptList = concepts
    .map((c) => {
      const aliases = c.nameJa ? ` aliases: ${c.nameJa}` : "";
      const evidence = c.sourceEvidence?.evidenceText || c.excerpt || c.evidenceText || "";
      return `- ${c.name} (${c.domain}, importance ${c.importance}/5)${aliases}: ${c.description}\n  Evidence: ${evidence}`;
    })
    .join("\n");
  const conceptByName = new Map(concepts.map((concept) => [concept.name, concept]));

  const response = await chatWithRetry({
    model,
    max_completion_tokens: 8192,
    tools: [buildRelationTool(0, maxRelations)],
    tool_choice: { type: "function", function: { name: "save_relations" } },
    messages: [
      {
        role: "system",
        content: `You are a knowledge graph specialist. Build a useful navigation graph between concepts from a book.

Relationship types:
- prerequisite: understanding A is needed before B
- same_family_as: A and B are sibling concepts in the same framework, family, cluster, or argument
- operationalizes: A turns B into a concrete practice, tool, habit, method, or workflow
- supports: A provides evidence, reinforcement, motivation, or enabling conditions for B
- contrasts_with: A and B are meaningfully different or opposed as a comparison, without direct contradiction
- contradicts: A and B make opposing or conflicting claims
- extends: B builds upon or specializes A
- applies_to: A is a technique/tool applied in domain B
- example_of: A is an example, instance, case, or manifestation of B
- reframes: A changes the interpretation, lens, framing, or meaning of B
- mitigates: A reduces, handles, or protects against a risk, bias, problem, or failure mode in B
- related: last resort only when the relationship is useful but none of the above applies

Create enough edges for a readable knowledge map:
- Every important concept should connect to 2-4 other concepts when reasonable.
- Prefer the most specific relationship type. Use related only as the final fallback.
- Use prerequisite, extends, applies_to, operationalizes, example_of, reframes, and mitigates for directional relationships.
- Use same_family_as for peer concepts that belong to the same argument, framework, practice, or problem.
- Use contrasts_with for distinctions and tradeoffs that are not strict contradictions.
- When a concept is a numbered or named framework, list, or system (e.g. "7 Habits", "PDCA", "5 Whys", "OKR"), explicitly link EVERY component principle, habit, step, or layer that appears in the concept list to the framework using example_of (component → framework). Do not skip any components.
- When sibling components belong to the same framework or argument (e.g. Habit 1 and Habit 2), link them with same_family_as.
- Connect practical methods to the concepts they apply or operationalize.
- Avoid self-loops and duplicate from/to pairs.
- Do not invent concepts outside the provided list.
- Evidence must be copied from the provided Evidence lines and must include one endpoint concept name or alias.`,
      },
      {
        role: "user",
        content: `Find relationships between these concepts from "${title}":

${conceptList}

Return up to ${maxRelations} evidence-backed relationships. Prefer a connected graph over isolated concept clusters only when the source evidence supports the relation. If a concept is a framework, principle, habit, or mental model central to the book, connect it to multiple relevant concepts when evidence is available.`,
      },
    ],
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    throw new Error("LLM did not return function call");
  }

  const input = JSON.parse(toolCall.function.arguments) as { relations: ExtractedRelation[] };

  // Build case-insensitive lookup: normalized name -> original name
  const normalize = (s: string) => s.toLowerCase().replace(/[\s\-_]/g, "");
  const nameMap = new Map<string, string>();
  for (const c of concepts) nameMap.set(normalize(c.name), c.name);

  const resolved = input.relations.flatMap((r) => {
    const from = nameMap.get(normalize(r.from));
    const to = nameMap.get(normalize(r.to));
    if (!from || !to || from === to) return [];
    const fromConcept = conceptByName.get(from);
    const toConcept = conceptByName.get(to);
    if (!fromConcept || !toConcept) return [];
    const confidence = clampConfidence((r as { confidence?: unknown }).confidence);
    if (!isValidRelationEvidence(
      r.evidence,
      { name: fromConcept.name, aliases: [fromConcept.nameJa].filter(Boolean) as string[] },
      { name: toConcept.name, aliases: [toConcept.nameJa].filter(Boolean) as string[] },
      [
        fromConcept.sourceEvidence?.evidenceText,
        fromConcept.excerpt,
        fromConcept.evidenceText,
        toConcept.sourceEvidence?.evidenceText,
        toConcept.excerpt,
        toConcept.evidenceText,
      ]
    )) {
      return [];
    }

    return [{ ...r, from, to, type: isRelationType(r.type) ? r.type : "related", confidence, source: "llm" as const }];
  });

  // Deduplicate
  const seen = new Set<string>();
  const deduped = resolved.filter((r) => {
    const key = `${r.from}||${r.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length >= minRelations) return deduped;

  return deduped;
}

function clampConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.5;
}
