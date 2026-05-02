import Anthropic from "@anthropic-ai/sdk";
import type { ExtractedConcept } from "./extract-concepts";

const client = new Anthropic();

export interface ExtractedRelation {
  from: string;
  to: string;
  type: "prerequisite" | "related" | "contradicts" | "extends" | "applies_to";
  evidence: string;
}

const RELATION_TOOL: Anthropic.Tool = {
  name: "save_relations",
  description: "Save extracted relationships between concepts",
  input_schema: {
    type: "object" as const,
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
        minItems: 1,
      },
    },
    required: ["relations"],
  },
};

export async function extractRelations(
  title: string,
  concepts: ExtractedConcept[]
): Promise<ExtractedRelation[]> {
  const conceptList = concepts.map((c) => `- ${c.name} (${c.domain}): ${c.description}`).join("\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    tools: [RELATION_TOOL],
    tool_choice: { type: "tool", name: "save_relations" },
    system: `You are a knowledge graph specialist. Identify meaningful relationships between concepts.

Relationship types:
- prerequisite: understanding A is needed before B
- related: general conceptual connection
- contradicts: opposing or conflicting ideas
- extends: B builds upon or specializes A
- applies_to: A is a technique/tool applied in domain B

Only create relationships that are substantive. Prefer fewer high-quality edges over many weak ones.`,
    messages: [
      {
        role: "user",
        content: `Find relationships between these concepts from "${title}":

${conceptList}

Create edges that represent meaningful knowledge dependencies and connections. Each concept should connect to at least 1-2 others.`,
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("LLM did not return tool_use block");
  }

  const input = toolUse.input as { relations: ExtractedRelation[] };

  // Filter to only relations between known concept names
  const names = new Set(concepts.map((c) => c.name));
  return input.relations.filter((r) => names.has(r.from) && names.has(r.to));
}
