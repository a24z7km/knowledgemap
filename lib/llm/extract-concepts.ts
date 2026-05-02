import OpenAI from "openai";
import { CONCEPT_DOMAINS, type ConceptDomain } from "@/lib/domains";
import {
  CONCEPT_LEVELS,
  CONCEPT_TYPES,
  SPECIFICITY_LEVELS,
  type ConceptLevel,
  type ConceptType,
  type Specificity,
} from "@/lib/concept-metadata";

const client = new OpenAI();

export type SourceType =
  | "title"
  | "subtitle"
  | "user_notes"
  | "google_books_description"
  | "categories"
  | "table_of_contents";

export interface SourceEvidence {
  sourceType: SourceType;
  evidenceText: string;
}

export interface ExtractedConcept {
  name: string;
  nameJa: string;
  description: string;
  importance: 1 | 2 | 3 | 4 | 5;
  excerpt: string;
  domain: ConceptDomain;
  conceptLevel: ConceptLevel;
  conceptType: ConceptType;
  specificity: Specificity;
  sourceEvidence: SourceEvidence;
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
                  "Short normalized concept name in English (no domain prefix, usually 1-6 words). Prefer named theories, mechanisms, technical terms, chapter-level terms, and author-specific concepts over broad topic labels.",
              },
              nameJa: {
                type: "string",
                description: "Japanese translation of the concept name (natural Japanese, concise but not abbreviated)",
              },
              description: {
                type: "string",
                description:
                  "1-3 sentence description that explains the concept's role in this specific book, not a generic dictionary definition",
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
                enum: CONCEPT_DOMAINS,
                description:
                  "Primary knowledge domain. Prefer a specific domain; use general only when no other domain fits.",
              },
              conceptLevel: {
                type: "string",
                enum: CONCEPT_LEVELS,
                description:
                  "core=central concept, chapter-level term, theory/model/technical term; supporting=needed to understand core; application=method/workflow/use; outcome=effect/result/goal; context=background/problem/precondition",
              },
              conceptType: {
                type: "string",
                enum: CONCEPT_TYPES,
                description: "The kind of concept: theory, model, framework, principle, technical_term, mechanism, method, practice, distinction, metric, institution, person, event, phenomenon, outcome, or theme",
              },
              specificity: {
                type: "string",
                enum: SPECIFICITY_LEVELS,
                description:
                  "book_specific=strongly tied to this book/author/chapter structure; domain_specific=important specialized domain concept; generic=broad cross-domain label. Keep generic at or below 20%.",
              },
              sourceEvidence: {
                type: "object",
                description: "The source field and exact text that justifies extracting this concept. Required for every concept.",
                properties: {
                  sourceType: {
                    type: "string",
                    enum: ["title", "subtitle", "user_notes", "google_books_description", "categories", "table_of_contents"],
                    description: "Which part of the source material this concept comes from",
                  },
                  evidenceText: {
                    type: "string",
                    description: "The specific text from the source material that supports this concept",
                  },
                },
                required: ["sourceType", "evidenceText"],
              },
            },
            required: [
              "name",
              "nameJa",
              "description",
              "importance",
              "excerpt",
              "domain",
              "conceptLevel",
              "conceptType",
              "specificity",
              "sourceEvidence",
            ],
          },
          minItems: 8,
          maxItems: 60,
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
        content: `You are a knowledge extraction specialist. Extract the book-specific knowledge structure from the provided source material only.

STRICT SOURCE-GROUNDING RULES (highest priority):
- Every concept must be grounded in the current book's source material (title, subtitle, user_notes, google_books_description, categories, or table_of_contents).
- Do not import concepts from other books, previous analyses, existing map concepts, or general knowledge.
- Do not mark a concept as book_specific unless it is explicitly supported by the source material.
- If the source material is sparse, return fewer grounded concepts rather than inventing plausible ones.
- Never infer concepts from "well-known structure of the book" or what the book "probably covers".
- For each concept you extract, record the exact sourceType and evidenceText from the source material.

Primary extraction goal:
- Extract concepts that are explicitly present in the source material.
- Prefer concepts that appear in chapter titles, repeated key terms, named theories, mechanisms, models, technical terms, author-specific ideas, and domain vocabulary found in the source.
- Do not fill the output with broad labels such as Motivation, Productivity, Leadership, Risk Management, Learning, Mindfulness, Ethics, Happiness, or Decision Making unless the source material explicitly names one as a central concept.
- If the source material contains proper nouns, specialist terms, chapter-level keywords, theory names, model names, mechanisms, metrics, technical terms, or named distinctions, extract those before abstract themes.
- Use abstract themes only when they support or connect specific concepts found in the source.

Treat the following as valid concepts, in priority order:
1. Book-specific or author-specific named concepts and chapter-level terms
2. Domain-specific theories, models, mechanisms, technical terms, institutions, metrics, and distinctions
3. Supporting concepts needed to understand the central structure
4. Practical methods, workflows, exercises, and applications
5. Outcomes, goals, broad themes, and background context

Naming rules:
- name: always in English, short (1-6 words), no domain prefixes (not "Security: TLS" just "TLS")
- nameJa: natural Japanese translation of the concept name
- If the source uses Japanese katakana for an English loanword, use the original English as name and put the katakana/Japanese form in nameJa
- Preserve famous named ideas when the book is known for them, such as "Be Proactive", "Circle of Influence", or "Think Win-Win".
- Preserve domain terms even when they are narrower than a broad self-help or business abstraction.

Concept metadata:
- conceptLevel:
  - core: the book's central concepts, chapter-title-level ideas, theory/model names, specialist vocabulary, author-specific terms
  - supporting: concepts needed to understand a core concept
  - application: practices, workflows, uses, exercises, interventions
  - outcome: effects, results, goals, benefits
  - context: background, problem framing, assumptions, conditions
- conceptType:
  - theory, model, framework, principle, technical_term, mechanism, method, practice, distinction, metric, institution, person, event, phenomenon, outcome, theme
- specificity:
  - book_specific: strongly tied to this book, author, or chapter structure
  - domain_specific: common in the field but essential to this book
  - generic: broad cross-domain labels. Keep generic <= 20% of the output.

Domain classification rules:
- thinking: thinking methods, mental models, creativity, framing, abstraction, idea generation
- self_management: habits, emotion regulation, anxiety, motivation, resilience, life management
- communication: listening, persuasion, dialogue, negotiation, relationships, influence
- decision_making: prioritization, tradeoffs, choices, judgment, planning, risk decisions
- mindfulness: awareness, meditation, presence, acceptance, non-judgmental observation
- ethics: virtues, morality, responsibility, fairness, values, character
- critical_thinking: skepticism, bias detection, misinformation, evidence evaluation, logical scrutiny
- productivity: execution, time management, workflow, focus, task systems
- learning: study, reflection, skill acquisition, memory, deliberate practice, experiential learning
- psychology: cognitive/emotional mechanisms, personality, behavioral patterns, therapy concepts
- business: strategy, marketing, entrepreneurship, markets, customers, business models
- economics: opportunity cost, marginal analysis, demand/supply, incentives, elasticity, macro/microeconomics
- sociology: institutions, social structures, roles, networks, norms, bureaucracy, social theory
- neuroscience: brain regions, neurotransmitters, neural mechanisms, cognition, reward, memory systems
- health: medicine, wellbeing, sleep, exercise, nutrition, clinical or public health concepts
- biology: biological systems, evolution, physiology, ecology, genetics
- history: historical periods, movements, events, historiography
- politics: governance, policy, power, democracy, ideology, political institutions
- education: pedagogy, curriculum, schooling, instructional design
- technology: non-CS technology, platforms, engineering systems, digital transformation
- security: security concepts outside strictly cyber contexts; physical, organizational, geopolitical security
- management: organizations, leadership, operations, teams, psychological safety, transaction costs, bureaucracy
- philosophy: metaphysics, epistemology, ethics schools, existentialism, utilitarianism, deontology, named philosophers
- cybersec: zero trust, authentication, authorization, threat modeling, attack surface, cryptography, network/app security
- finance / law / cs / math: use for clearly technical concepts in those fields
- general: last resort only. Avoid using general when a more specific domain above applies.

Bad extraction examples:
- Economics book: Decision Making / Business Strategy / Productivity only
- Security book: Risk Management / Trust / Compliance only
- Neuroscience book: Motivation / Focus / Self Management only
- Philosophy book: Ethics / Happiness / Life Purpose only

Good extraction examples:
- Economics: Opportunity Cost, Marginal Utility, Demand Curve, Price Elasticity, Externality
- Security: Zero Trust, Authentication, Authorization, Threat Modeling, Attack Surface
- Neuroscience: Dopamine, Serotonin, Noradrenaline, Working Memory, Reward System
- Philosophy: Utilitarianism, Deontology, Existentialism, Categorical Imperative

Output balance:
- 40-60%: core and/or domain_specific concepts
- 20-30%: supporting concepts
- 10-25%: application or practice concepts
- 5-15%: outcome or context concepts
- generic specificity must be <= 20%.
- Avoid assigning more than 20% of concepts to general domain unless the book truly spans unrelated topics.`,
      },
      {
        role: "user",
        content: `Extract knowledge concepts from this book. Only extract concepts that are directly supported by the source material below.

Title: ${title}
Author: ${author}

Structured source material:
${notes || "(No source material provided. Return an empty list — do not invent concepts.)"}

Extraction procedure:
1. Read the source material carefully.
2. Extract only concepts that appear explicitly in the source material (title, subtitle, user_notes, google_books_description, categories, table_of_contents).
3. For each concept, record sourceEvidence with the exact sourceType and a verbatim or near-verbatim evidenceText from the source.
4. Do not add concepts from other books, general knowledge, or your prior training about what this book "typically covers".
5. If the source material mentions few specific terms, return fewer concepts. Quality over quantity.

Prefer:
- "Dopamine", "Reward System", "Working Memory" over only "Motivation" or "Focus" — but only if they appear in the source
- "Opportunity Cost", "Demand Curve" over only "Decision Making" — but only if they appear in the source
- "Zero Trust", "Authentication", "Threat Modeling" over only "Risk Management" — but only if they appear in the source

If only broad themes are available in the source, mark them as generic and keep them under 20%. Return 8-60 concepts; return fewer if the source is sparse.`,
      },
    ],
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    throw new Error("LLM did not return function call");
  }

  const input = JSON.parse(toolCall.function.arguments) as { concepts: ExtractedConcept[] };
  const all = normalizeExtractedConcepts(input.concepts ?? []);
  return all.filter((c) => c.sourceEvidence?.sourceType && c.sourceEvidence?.evidenceText);
}

function normalizeExtractedConcepts(concepts: ExtractedConcept[]): ExtractedConcept[] {
  const unique = new Map<string, ExtractedConcept>();

  for (const concept of concepts) {
    const normalized = normalizeExtractedConcept(concept);
    const key = normalized.name.trim().toLowerCase();
    if (!key) continue;
    const previous = unique.get(key);
    if (!previous || normalized.importance > previous.importance) {
      unique.set(key, normalized);
    }
  }

  const sorted = [...unique.values()].sort((a, b) => {
    const specificityScore = scoreSpecificity(b.specificity) - scoreSpecificity(a.specificity);
    if (specificityScore !== 0) return specificityScore;
    const levelScore = scoreLevel(b.conceptLevel) - scoreLevel(a.conceptLevel);
    if (levelScore !== 0) return levelScore;
    return b.importance - a.importance;
  });

  const genericLimit = Math.max(1, Math.floor(sorted.length * 0.2));
  let genericCount = 0;
  return sorted.filter((concept) => {
    if (concept.specificity !== "generic") return true;
    genericCount += 1;
    return genericCount <= genericLimit;
  });
}

const SOURCE_TYPES: SourceType[] = [
  "title",
  "subtitle",
  "user_notes",
  "google_books_description",
  "categories",
  "table_of_contents",
];

function normalizeExtractedConcept(concept: ExtractedConcept): ExtractedConcept {
  return {
    ...concept,
    name: concept.name?.trim() ?? "",
    nameJa: concept.nameJa?.trim() ?? "",
    description: concept.description?.trim() ?? "",
    excerpt: concept.excerpt?.trim() ?? "",
    importance: clampImportance(concept.importance),
    domain: CONCEPT_DOMAINS.includes(concept.domain) ? concept.domain : "general",
    conceptLevel: CONCEPT_LEVELS.includes(concept.conceptLevel) ? concept.conceptLevel : "supporting",
    conceptType: CONCEPT_TYPES.includes(concept.conceptType) ? concept.conceptType : "theme",
    specificity: SPECIFICITY_LEVELS.includes(concept.specificity) ? concept.specificity : "domain_specific",
    sourceEvidence: concept.sourceEvidence && SOURCE_TYPES.includes(concept.sourceEvidence.sourceType)
      ? { sourceType: concept.sourceEvidence.sourceType, evidenceText: concept.sourceEvidence.evidenceText?.trim() ?? "" }
      : { sourceType: "google_books_description", evidenceText: "" },
  };
}

function clampImportance(value: number): 1 | 2 | 3 | 4 | 5 {
  const rounded = Math.round(Number(value));
  if (rounded <= 1) return 1;
  if (rounded >= 5) return 5;
  return rounded as 1 | 2 | 3 | 4 | 5;
}

function scoreSpecificity(specificity: Specificity) {
  if (specificity === "book_specific") return 3;
  if (specificity === "domain_specific") return 2;
  return 1;
}

function scoreLevel(level: ConceptLevel) {
  if (level === "core") return 5;
  if (level === "supporting") return 4;
  if (level === "application") return 3;
  if (level === "context") return 2;
  return 1;
}
