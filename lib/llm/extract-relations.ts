import OpenAI from "openai";
import type { ExtractedConcept } from "./extract-concepts";

const client = new OpenAI();

export interface ExtractedRelation {
  from: string;
  to: string;
  type: "prerequisite" | "related" | "contradicts" | "extends" | "applies_to";
  evidence: string;
}

type RelationType = ExtractedRelation["type"];

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
                  enum: ["prerequisite", "related", "contradicts", "extends", "applies_to"],
                  description:
                    "prerequisite: A must be understood before B; related: general connection; contradicts: opposing views; extends: B builds on A; applies_to: A is applied in context of B",
                },
                evidence: { type: "string", description: "Brief justification for this relationship" },
              },
              required: ["from", "to", "type", "evidence"],
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
    .map((c) => `- ${c.name} (${c.domain}, importance ${c.importance}/5): ${c.description}`)
    .join("\n");

  const response = await client.chat.completions.create({
    model,
    max_tokens: 8192,
    tools: [buildRelationTool(minRelations, maxRelations)],
    tool_choice: { type: "function", function: { name: "save_relations" } },
    messages: [
      {
        role: "system",
        content: `You are a knowledge graph specialist. Build a useful navigation graph between concepts from a book.

Relationship types:
- prerequisite: understanding A is needed before B
- related: general conceptual connection
- contradicts: opposing or conflicting ideas
- extends: B builds upon or specializes A
- applies_to: A is a technique/tool applied in domain B

Create enough edges for a readable knowledge map:
- Every important concept should connect to 2-4 other concepts when reasonable.
- Use prerequisite, extends, and applies_to for directional relationships.
- Use related for peer concepts that belong to the same argument, framework, practice, or problem.
- Avoid self-loops and duplicate from/to pairs.
- Do not invent concepts outside the provided list.`,
      },
      {
        role: "user",
        content: `Find relationships between these concepts from "${title}":

${conceptList}

Return ${minRelations}-${maxRelations} relationships. Prefer a connected graph over isolated concept clusters. If a concept is central to the book, connect it to multiple relevant concepts.`,
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
    return [{ ...r, from, to }];
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

  const rankedConcepts = [...concepts].sort((a, b) => b.importance - a.importance);
  const fallbackRelations: ExtractedRelation[] = [];
  const addRelation = (from: string, to: string, type: RelationType, evidence: string) => {
    if (from === to) return;
    const key = `${from}||${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    fallbackRelations.push({ from, to, type, evidence });
  };

  for (const concept of rankedConcepts) {
    const related = rankedConcepts
      .filter((candidate) => candidate.name !== concept.name && candidate.domain === concept.domain)
      .slice(0, 2);

    for (const candidate of related) {
      addRelation(
        concept.name,
        candidate.name,
        "related",
        "Both concepts are important in the same domain for this book."
      );
      if (deduped.length + fallbackRelations.length >= minRelations) {
        return [...deduped, ...fallbackRelations];
      }
    }
  }

  for (let i = 0; i < rankedConcepts.length - 1; i += 1) {
    addRelation(
      rankedConcepts[i].name,
      rankedConcepts[i + 1].name,
      "related",
      "Both concepts appear as important ideas in this book."
    );
    if (deduped.length + fallbackRelations.length >= minRelations) break;
  }

  return [...deduped, ...fallbackRelations];
}
