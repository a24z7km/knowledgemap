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
                description:
                  "Short normalized concept, framework, principle, mental model, or practice name in English (no domain prefix, 1-6 words)",
              },
              nameJa: {
                type: "string",
                description: "Japanese translation of the concept name (natural Japanese, concise but not abbreviated)",
              },
              description: {
                type: "string",
                description:
                  "1-3 sentence description that explains how the idea, framework, principle, or practice is used in the book",
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
          minItems: 10,
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
        content: `You are a knowledge extraction specialist. Extract reusable knowledge units from books across business, psychology, philosophy, cybersecurity, finance, law, math, and computer science.

Treat the following as valid concepts:
- named frameworks and models
- principles, laws, habits, maxims, and rules of thumb
- ways of thinking, mental models, and decision lenses
- practices, methods, workflows, and exercises
- key distinctions, tradeoffs, and recurring patterns
- technical/domain concepts

Naming rules:
- name: always in English, short (1-6 words), no domain prefixes (not "Security: TLS" just "TLS")
- nameJa: natural Japanese translation of the concept name
- If the source uses Japanese katakana for an English loanword, use the original English as name and put the katakana/Japanese form in nameJa
- Preserve famous named ideas when the book is known for them, such as "Be Proactive", "Circle of Influence", or "Think Win-Win".`,
      },
      {
        role: "user",
        content: `Extract 15-50 reusable knowledge units from this book:

Title: ${title}
Author: ${author}

Notes/Summary:
${notes || "(No notes provided — infer well-known concepts, frameworks, and thinking patterns from the title and author)"}

Include not only topic nouns, but also the frameworks, principles, ways of thinking, practical methods, and key distinctions explained by the book.

Balance the output:
- 30-50% named frameworks, principles, habits, or mental models
- 30-50% supporting concepts needed to understand them
- 10-30% practices, applications, or tradeoffs

Prefer book-specific ideas over generic labels. For example, extract "Circle of Influence" rather than only "Self Improvement".`,
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
