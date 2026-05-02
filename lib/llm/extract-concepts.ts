import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export interface ExtractedConcept {
  name: string;
  description: string;
  importance: 1 | 2 | 3 | 4 | 5;
  excerpt: string;
  domain: "cybersec" | "finance" | "law" | "cs" | "math" | "general";
}

const CONCEPT_TOOL: Anthropic.Tool = {
  name: "save_concepts",
  description: "Save extracted concepts from the book",
  input_schema: {
    type: "object" as const,
    properties: {
      concepts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Short normalized concept name in English or Japanese (no domain prefix)",
            },
            description: {
              type: "string",
              description: "1-3 sentence description of the concept",
            },
            importance: {
              type: "integer",
              minimum: 1,
              maximum: 5,
              description: "How central this concept is to the book (5=core, 1=peripheral)",
            },
            excerpt: {
              type: "string",
              description: "Short quote or paraphrase from the source material",
            },
            domain: {
              type: "string",
              enum: ["cybersec", "finance", "law", "cs", "math", "general"],
              description: "Primary knowledge domain",
            },
          },
          required: ["name", "description", "importance", "excerpt", "domain"],
        },
        minItems: 5,
        maxItems: 50,
      },
    },
    required: ["concepts"],
  },
};

export async function extractConcepts(
  title: string,
  author: string,
  notes: string
): Promise<ExtractedConcept[]> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    tools: [CONCEPT_TOOL],
    tool_choice: { type: "tool", name: "save_concepts" },
    system: `You are a knowledge extraction specialist. Extract key concepts from books across cybersecurity, finance, law, and computer science.

Naming rules:
- Use the most common English or Japanese term
- Keep names short (1-4 words)
- No domain prefixes (not "Security: TLS" just "TLS")
- Use standard normalized forms (e.g. "TLS handshake" not "TLS Handshaking Protocol")`,
    messages: [
      {
        role: "user",
        content: `Extract 10-50 key concepts from this book:

Title: ${title}
Author: ${author}

Notes/Summary:
${notes || "(No notes provided — infer concepts from title and author)"}

Extract the most important concepts, frameworks, and ideas from this book. Focus on reusable knowledge that connects to other domains.`,
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("LLM did not return tool_use block");
  }

  const input = toolUse.input as { concepts: ExtractedConcept[] };
  return input.concepts;
}
