import { CONCEPT_DOMAINS, type ConceptDomain } from "@/lib/domains";
import type { ConceptCandidate } from "./generate-concept-candidates";
import {
  EXTRACTION_CATEGORIES,
  GROUNDING_TYPES,
  type ConceptLevel,
  type ConceptType,
  type ExtractionCategory,
  type GroundingType,
  type Specificity,
} from "@/lib/concept-metadata";
import OpenAI from "openai";
import { chatWithRetry } from "./openai-client";

export type SourceType =
  | "metadata"
  | "user_notes"
  | "google_books_description"
  | "categories"
  | "table_of_contents"
  | "openbd_description"
  | "openbd_table_of_contents"
  | "ndl_description"
  | "ndl_subjects";

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
  category: ExtractionCategory;
  groundingType: GroundingType;
  evidenceText: string;
  specificityScore: 1 | 2 | 3 | 4 | 5;
  confidence: number;
  conceptLevel: ConceptLevel;
  conceptType: ConceptType;
  specificity: Specificity;
  sourceEvidence: SourceEvidence;
}

interface LlmExtractedConcept {
  name?: string;
  nameJa?: string;
  description?: string;
  importance?: number;
  excerpt?: string;
  domain?: ConceptDomain;
  category?: ExtractionCategory;
  groundingType?: GroundingType;
  evidenceText?: string;
  specificity?: number;
  confidence?: number;
}

export interface TargetCount {
  min: number;
  max: number;
}

function buildConceptTool(targetCount: TargetCount): OpenAI.ChatCompletionTool {
  return {
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
              category: {
                type: "string",
                enum: EXTRACTION_CATEGORIES,
                description: "thesis, framework, component, practice, outcome, or context",
              },
              groundingType: {
                type: "string",
                enum: GROUNDING_TYPES,
                description: "source_explicit, source_supported, metadata_only, or model_prior",
              },
              evidenceText: {
                type: "string",
                description: "Exact source phrase, candidate phrase, or concise evidence text used to ground this candidate",
              },
              specificity: {
                type: "integer",
                minimum: 1,
                maximum: 5,
                description: "How specific the concept is to this book/domain. 5=highly specific, 1=generic",
              },
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description: "Confidence that this is a useful concept candidate grounded in the source",
              },
              },
              required: [
                "name",
                "nameJa",
                "description",
                "importance",
                "excerpt",
                "domain",
                "category",
                "groundingType",
                "evidenceText",
                "specificity",
                "confidence",
              ],
            },
            minItems: targetCount.min,
            maxItems: targetCount.max,
          },
        },
        required: ["concepts"],
      },
    },
  };
}

export async function extractConcepts(
  title: string,
  author: string,
  notes: string,
  model = "gpt-4o-mini",
  candidates: ConceptCandidate[] = [],
  targetCount: TargetCount = { min: 12, max: 30 }
): Promise<ExtractedConcept[]> {
  const candidateBlock =
    candidates.length > 0
      ? `\n\nPre-extracted concept candidates (${candidates.length} total, from TOC/subjects/user notes):\n` +
        candidates
          .map((c) => `- [${c.sourceType}] ${c.text}  (evidence: "${c.evidenceText}")`)
          .join("\n")
      : "";

  const response = await chatWithRetry({
    model,
    max_completion_tokens: 8192,
    tools: [buildConceptTool(targetCount)],
    tool_choice: { type: "function", function: { name: "save_concepts" } },
    messages: [
      {
        role: "system",
        content: `You are a knowledge extraction specialist. Extract the book-specific knowledge structure from the provided source material only.

SOURCE-GROUNDING RULES (highest priority):
- Every concept must be grounded in the current book source material: descriptions, table of contents, reviews, subjects/categories, user notes, user TOC, or user summary. Title, author, subtitle, publisher, date, ISBN, and page count are search/book-identification metadata, not concept-extraction source.
- Concepts may be explicitly stated OR strongly supported by the source material. Decomposition is a candidate expansion technique, NOT the primary route. Only use it when source explicitly mentions the umbrella term AND the decomposition is canonical for the field.
- Do not import concepts from other books, previous analyses, existing map concepts, or unrelated general knowledge.
- Do not infer concepts from the book's reputation or what it "probably covers" — only from the actual source text provided.
- For each concept, record groundingType and evidenceText.
- When a source section includes "Source URL:", evidenceText must include that URL together with the source phrase.
- groundingType:
  - source_explicit: the exact concept name or close equivalent appears in the source
  - source_supported: directly supported by a source phrase, heading, subject, review, user field, or description
  - metadata_only: based only on title, author, subtitle, publisher, ISBN, or other identification metadata; avoid this except as a weak candidate
  - model_prior: model domain prior, book reputation, or known-book knowledge; use only for whitelisted canonical books, otherwise it will be rejected
- specificity is numeric 1-5: 5=book-specific/chapter-level/named term, 3=domain-specific, 1=generic.

VOLUME RULES:
- This is the candidate-generation stage, but the source material controls volume.
- Target ${targetCount.min}-${targetCount.max} grounded candidates when the source supports that many.
- If there are fewer than ${targetCount.min} genuinely grounded candidates, return only the grounded candidates you can support.
- Filler is forbidden. Do not pad the output with generic concepts or book-reputation guesses.
- If the source contains a table of contents or candidate list, process it broadly instead of choosing only the top few.
- It is better to return a small grounded candidate pool than a large ungrounded one.

Primary extraction goal:
- First identify the organizing axis of the book from descriptions, categories, table of contents, reviews, and user-provided source fields.
- Extract chapter-level, repeated, named, specialist, or author-specific concepts explicitly present in the source first.
- When the source names a broad domain category (e.g. "brain chemicals", "microeconomics", "authentication"), decompose only when that umbrella term is explicit and the sub-concepts are canonical for the field.
- Do not fill the output with generic labels (Motivation, Leadership, Risk Management, Mindfulness, Happiness, Decision Making) unless the source explicitly uses them as a central named concept.
- Use abstract themes only as supporting or context concepts, not as the core of the extraction.

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

Candidate metadata:
- category:
  - thesis: the book's central claim or argumentative axis
  - framework: named container, framework, model, or overall structure
  - component: part of a framework, numbered habit/principle, mechanism, technical component, or sub-concept
  - practice: action, exercise, workflow, method, behavior, application
  - outcome: result, benefit, effect, goal
  - context: background, problem framing, precondition, audience, domain context
- groundingType and evidenceText are required for every candidate.
- evidenceText must preserve the source URL when the evidence came from a web-fetched source.
- importance: 1-5, centrality to the book.
- specificity: 1-5, concept specificity.
- confidence: 0-1, confidence this should remain in the raw candidate pool.

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
- 40-60%: framework/component/thesis candidates
- 20-30%: supporting component/context candidates
- 10-25%: practice candidates
- 5-15%: outcome candidates
- low-specificity generic candidates should be <= 20%.
- Avoid assigning more than 20% of concepts to general domain unless the book truly spans unrelated topics.`,
      },
      {
        role: "user",
        content: `Extract a large raw candidate pool from this book. Ground every candidate in the source material below.

Title: ${title}
Author: ${author}

Structured source material:
${notes || "(No source material provided. Return an empty list — do not invent concepts.)"}
${candidateBlock}

Extraction procedure:
${candidates.length > 0 ? `1. You have been given ${candidates.length} pre-extracted concept candidates from TOC, subjects, and user notes (see above).
   - Process EVERY candidate: assign English name, nameJa, description, domain, category, groundingType, evidenceText, importance, specificity, and confidence.
   - Filter out noise (marketing copy, structural labels like "Chapter", metadata like "ISBN", role labels like "著者").
   - Do NOT aggressively deduplicate. This is a raw candidate stage; near-duplicates are acceptable if they have different evidence.
2. After processing all valid candidates, add additional concepts that are grounded in the source material (descriptions, TOC, reviews, subjects/categories, or user-provided fields) but not already covered by the candidates.
3. Do NOT add concepts from other books, prior analyses, or unrelated general knowledge.
4. For each concept, set groundingType and evidenceText. If evidence came from a web source, include its Source URL in evidenceText.` : `1. Read the source material carefully.
2. Identify the organizing axis: field, central topic, named theories, chapter structure, key terms.
3. Extract concepts that are explicitly named in the source first.
4. Candidate expansion warning: decomposition is NOT the primary route. Only decompose a broad source term (e.g. "脳内物質", "microeconomics", "zero trust") when the source explicitly mentions that umbrella term AND the decomposition is canonical for the field.
5. Do not add concepts from other books, prior analyses, or unrelated general knowledge.
6. For each concept, set groundingType and evidenceText. If evidence came from a web source, include its Source URL in evidenceText.`}

Noise to exclude (do NOT create concepts for these):
- Marketing copy: "ベストセラー", "不朽の名著", "感動の書", "公式本"
- Metadata: "著者", "訳者", "編者", "出版社", "ISBN", "発売日", "価格"
- Structural labels: "第n章", "PART I", "はじめに", "おわりに", "索引", "参考文献"
- Generic role/format labels: "改訂版", "文庫版", "内容紹介"

Prefer specific domain terms over generic labels:
- "Dopamine", "Serotonin", "Noradrenaline", "Working Memory" over only "Motivation" or "Focus"
- "Opportunity Cost", "Demand Curve", "Marginal Utility" over only "Decision Making"
- "Zero Trust", "Authentication", "Threat Modeling" over only "Risk Management"

Return ${targetCount.min}-${targetCount.max} candidates if there is enough source material. If there are fewer than ${targetCount.min} genuinely grounded candidates, return all grounded candidates and avoid invented filler. Generic concepts must stay under 20%.`,
      },
    ],
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    throw new Error("LLM did not return function call");
  }

  const input = JSON.parse(toolCall.function.arguments) as { concepts: LlmExtractedConcept[] };
  const { sourceText, metadataText } = splitSourceAndMetadataText(notes);
  const all = normalizeExtractedConcepts(input.concepts ?? [], sourceText, metadataText);
  return all;
}

function normalizeExtractedConcepts(
  concepts: LlmExtractedConcept[],
  sourceText: string,
  metadataText: string
): ExtractedConcept[] {
  return concepts
    .map((concept) => normalizeExtractedConcept(concept, sourceText, metadataText))
    .filter((concept) => concept.name.length > 0);
}

function normalizeExtractedConcept(
  concept: LlmExtractedConcept,
  sourceText: string,
  metadataText: string
): ExtractedConcept {
  const category = EXTRACTION_CATEGORIES.includes(concept.category as ExtractionCategory)
    ? concept.category as ExtractionCategory
    : "context";
  const claimedGroundingType = GROUNDING_TYPES.includes(concept.groundingType as GroundingType)
    ? concept.groundingType as GroundingType
    : "model_prior";
  const specificityScore = clampImportance(concept.specificity ?? 3);
  const evidenceText = attachSourceUrlToEvidence(concept.evidenceText?.trim() ?? "", sourceText);
  const groundingType = verifyGroundingType(claimedGroundingType, evidenceText, sourceText, metadataText);

  return {
    name: concept.name?.trim() ?? "",
    nameJa: concept.nameJa?.trim() ?? "",
    description: concept.description?.trim() ?? "",
    excerpt: concept.excerpt?.trim() ?? "",
    importance: clampImportance(concept.importance ?? 3),
    domain: concept.domain && CONCEPT_DOMAINS.includes(concept.domain) ? concept.domain : "general",
    category,
    groundingType,
    evidenceText,
    specificityScore,
    confidence: clampConfidence(concept.confidence),
    conceptLevel: categoryToConceptLevel(category),
    conceptType: categoryToConceptType(category),
    specificity: scoreToSpecificity(specificityScore, groundingType),
    sourceEvidence: { sourceType: groundingType === "metadata_only" ? "metadata" : "google_books_description", evidenceText },
  };
}

function verifyGroundingType(
  groundingType: GroundingType,
  evidenceText: string,
  sourceText: string,
  metadataText: string
): GroundingType {
  if (/^(Title|Author):/i.test(evidenceText.trim())) return "model_prior";
  if (groundingType === "source_explicit" && !sourceIncludesEvidence(sourceText, evidenceText)) return "model_prior";
  if (groundingType === "metadata_only" && !sourceIncludesEvidence(metadataText, evidenceText)) return "model_prior";
  if (groundingType === "source_supported" && sourceIncludesEvidence(metadataText, evidenceText) && !sourceIncludesEvidence(sourceText, evidenceText)) {
    return "metadata_only";
  }
  return groundingType;
}

function splitSourceAndMetadataText(text: string): { sourceText: string; metadataText: string } {
  const metadataMatch = text.match(/\[Book Metadata\]([\s\S]*?)(?=\n\n\[[^\]]+\]|$)/);
  const metadataText = metadataMatch?.[0] ?? "";
  return {
    metadataText,
    sourceText: metadataText ? text.replace(metadataText, "") : text,
  };
}

function attachSourceUrlToEvidence(evidenceText: string, sourceText: string): string {
  if (!evidenceText || extractEvidenceUrl(evidenceText)) return evidenceText;

  const evidence = normalizeEvidence(evidenceText);
  if (!evidence) return evidenceText;

  for (const block of sourceText.split(/\n(?=- source: )/)) {
    if (!normalizeEvidence(block).includes(evidence)) continue;
    const sourceUrl = block.match(/Source URL:\s*(https?:\/\/\S+)/i)?.[1];
    return sourceUrl ? `${evidenceText} [Source URL: ${sourceUrl}]` : evidenceText;
  }

  return evidenceText;
}

function sourceIncludesEvidence(sourceText: string, evidenceText: string): boolean {
  const evidence = normalizeEvidence(evidenceText);
  if (!evidence) return false;
  const source = normalizeEvidence(sourceText);
  if (source.includes(evidence)) return true;

  const url = extractEvidenceUrl(evidenceText);
  if (!url) return false;
  const phrase = normalizeEvidence(evidenceText.replace(url, "").replace(/\[?source url:?\]?/ig, ""));
  return source.includes(normalizeEvidence(url)) && Boolean(phrase) && source.includes(phrase);
}

function extractEvidenceUrl(value: string): string | null {
  return value.match(/https?:\/\/[^\s\])}>"']+/i)?.[0] ?? null;
}

function normalizeEvidence(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function clampImportance(value: number): 1 | 2 | 3 | 4 | 5 {
  const rounded = Math.round(Number(value));
  if (rounded <= 1) return 1;
  if (rounded >= 5) return 5;
  return rounded as 1 | 2 | 3 | 4 | 5;
}

function clampConfidence(value: number | undefined): number {
  const numeric = Number(value ?? 0.5);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.min(1, Math.max(0, numeric));
}

function categoryToConceptLevel(category: ExtractionCategory): ConceptLevel {
  if (category === "thesis" || category === "framework" || category === "component") return "core";
  if (category === "practice") return "application";
  if (category === "outcome") return "outcome";
  return "context";
}

function categoryToConceptType(category: ExtractionCategory): ConceptType {
  if (category === "framework") return "framework";
  if (category === "practice") return "practice";
  if (category === "outcome") return "outcome";
  if (category === "thesis") return "principle";
  if (category === "component") return "technical_term";
  return "theme";
}

function scoreToSpecificity(score: 1 | 2 | 3 | 4 | 5, groundingType: GroundingType): Specificity {
  if (groundingType === "source_explicit" || score >= 4) return "book_specific";
  if (score >= 3 || groundingType === "source_supported") return "domain_specific";
  return "generic";
}
