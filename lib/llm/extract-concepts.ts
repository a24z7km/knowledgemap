import OpenAI from "openai";

const client = new OpenAI();

export interface ExtractedConcept {
  name: string;
  nameJa: string;
  description: string;
  importance: 1 | 2 | 3 | 4 | 5;
  excerpt: string;
  domain: "cybersec" | "finance" | "law" | "cs" | "math" | "general";
}

const CONCEPT_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "save_concepts",
    description: "Save extracted concepts from the book",
    parameters: {
      type: "object",
      properties: {
        concepts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Short normalized concept name in English (no domain prefix, 1-4 words)",
              },
              nameJa: {
                type: "string",
                description: "Japanese translation of the concept name (2-8 characters, natural Japanese)",
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
            required: ["name", "nameJa", "description", "importance", "excerpt", "domain"],
          },
          minItems: 5,
          maxItems: 50,
        },
      },
      required: ["concepts"],
    },
  },
};

export async function extractConcepts(
  title: string,
  author: string,
  notes: string,
  model = "gpt-4o-mini"
): Promise<ExtractedConcept[]> {
  const response = await client.chat.completions.create({
    model,
    max_tokens: 4096,
    tools: [CONCEPT_TOOL],
    tool_choice: { type: "function", function: { name: "save_concepts" } },
    messages: [
      {
        role: "system",
        content: `You are a knowledge extraction specialist. Extract key concepts from books across cybersecurity, finance, law, and computer science.

Naming rules:
- name: always in English, short (1-4 words), no domain prefixes (not "Security: TLS" just "TLS")
- nameJa: natural Japanese translation of the concept name`,
      },
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

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    throw new Error("LLM did not return function call");
  }

  const input = JSON.parse(toolCall.function.arguments) as { concepts: ExtractedConcept[] };
  return input.concepts;
}
