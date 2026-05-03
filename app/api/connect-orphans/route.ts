import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { concepts, bookConcepts, conceptRelations } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { normalizeConceptRelation, relationIdentityKey, RELATION_TYPES, type RelationType, isRelationType } from "@/lib/relations";
import { chatWithRetry } from "@/lib/llm/openai-client";
import { parseToolArgumentsArray } from "@/lib/llm/tool-arguments";

const ANCHOR_LIMIT = 40; // ネットワーク側から渡す代表概念数
const BATCH_SIZE = 10;   // 孤立概念を何件ずつLLMに投げるか

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const model: string = body.model ?? "gpt-4o-mini";

  const db = getDb();

  // 既存リレーションに登場するノードIDを収集
  const allRels = await db.select({
    from: conceptRelations.fromConceptId,
    to: conceptRelations.toConceptId,
  }).from(conceptRelations);

  const connectedIds = new Set<number>();
  for (const r of allRels) { connectedIds.add(r.from); connectedIds.add(r.to); }

  // 全概念取得
  const allConcepts = await db.select({
    id: concepts.id,
    name: concepts.name,
    description: concepts.description,
    domain: concepts.domain,
  }).from(concepts);

  const orphans = allConcepts.filter((c) => !connectedIds.has(c.id));
  if (orphans.length === 0) {
    return NextResponse.json({ ok: true, message: "孤立概念はありません", newRelations: 0 });
  }

  // 接続数（degree）でソートしてアンカー概念を選ぶ
  const degreeById = new Map<number, number>();
  for (const r of allRels) {
    degreeById.set(r.from, (degreeById.get(r.from) ?? 0) + 1);
    degreeById.set(r.to, (degreeById.get(r.to) ?? 0) + 1);
  }
  const anchors = allConcepts
    .filter((c) => connectedIds.has(c.id))
    .sort((a, b) => (degreeById.get(b.id) ?? 0) - (degreeById.get(a.id) ?? 0))
    .slice(0, ANCHOR_LIMIT);

  // 既存リレーションキーを収集（重複挿入防止）
  const existingKeys = new Set(
    allRels.map((r) => relationIdentityKey(
      normalizeConceptRelation({ fromConceptId: r.from, toConceptId: r.to, relationType: "related", bookId: null })
    ))
  );
  // より正確に: 実際のrelationTypeで取得
  const fullRels = await db.select().from(conceptRelations);
  const existingRelKeys = new Set(
    fullRels.map((r) =>
      relationIdentityKey(normalizeConceptRelation({
        fromConceptId: r.fromConceptId,
        toConceptId: r.toConceptId,
        relationType: r.relationType as RelationType,
        bookId: r.bookId,
      }))
    )
  );

  const anchorList = anchors
    .map((c) => `- ${c.name} (${c.domain}): ${c.description ?? ""}`)
    .join("\n");

  let totalNew = 0;

  // 孤立概念をバッチ処理
  for (let i = 0; i < orphans.length; i += BATCH_SIZE) {
    const batch = orphans.slice(i, i + BATCH_SIZE);
    const orphanList = batch
      .map((c) => `- ${c.name} (${c.domain}): ${c.description ?? ""}`)
      .join("\n");

    const allNames = new Set([...batch.map((c) => c.name), ...anchors.map((c) => c.name)]);

    let rawRelations: { from: string; to: string; type: string; evidence: string }[] = [];
    try {
      const response = await chatWithRetry({
        model,
        max_completion_tokens: 4096,
        tools: [{
          type: "function",
          function: {
            name: "save_relations",
            parameters: {
              type: "object",
              properties: {
                relations: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      from: { type: "string" },
                      to: { type: "string" },
                      type: { type: "string", enum: RELATION_TYPES },
                      evidence: { type: "string" },
                    },
                    required: ["from", "to", "type", "evidence"],
                  },
                },
              },
              required: ["relations"],
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "save_relations" } },
        messages: [
          {
            role: "system",
            content: `You are a knowledge graph specialist. Your task is to connect ISOLATED concepts into an existing knowledge network.

Relationship types: ${RELATION_TYPES.join(", ")}
- prerequisite: A must be understood before B
- same_family_as: sibling concepts in the same framework or cluster
- operationalizes: A makes B concrete (practice/tool)
- supports: A reinforces or enables B
- contrasts_with: meaningful difference between A and B
- extends: B builds on A
- applies_to: A is a technique applied to B
- example_of: A is an instance of B
- reframes: A changes how B is interpreted
- mitigates: A reduces a risk/problem in B
- related: last resort fallback

Rules:
- Each ISOLATED concept MUST connect to at least 1 anchor concept.
- Only use exact names from the provided lists.
- Prefer directional, specific relation types over "related".`,
          },
          {
            role: "user",
            content: `Connect each ISOLATED concept to relevant ANCHOR concepts.

ISOLATED CONCEPTS (must be connected):
${orphanList}

ANCHOR CONCEPTS (already in the network):
${anchorList}

For each isolated concept, find 1-3 meaningful connections to anchor concepts. Return only relations where at least one endpoint is an isolated concept.`,
          },
        ],
      });

      const toolCall = response.choices[0]?.message?.tool_calls?.[0];
      if (toolCall?.type === "function") {
        rawRelations = parseToolArgumentsArray<(typeof rawRelations)[number]>(toolCall.function.arguments, "relations");
      }
    } catch {
      // バッチ失敗はスキップして次へ
      continue;
    }

    // 概念名 → ID マップ
    const nameToId = new Map<string, number>();
    for (const c of [...batch, ...anchors]) nameToId.set(c.name, c.id);

    const normalize = (s: string) => s.toLowerCase().replace(/[\s\-_]/g, "");
    const normalizedMap = new Map<string, string>();
    for (const name of allNames) normalizedMap.set(normalize(name), name);

    for (const rel of rawRelations) {
      const fromName = normalizedMap.get(normalize(rel.from)) ?? rel.from;
      const toName = normalizedMap.get(normalize(rel.to)) ?? rel.to;
      const fromId = nameToId.get(fromName);
      const toId = nameToId.get(toName);
      if (!fromId || !toId || fromId === toId) continue;
      if (!isRelationType(rel.type)) continue;

      // 孤立概念が少なくとも片方に含まれていること
      const batchIds = new Set(batch.map((c) => c.id));
      if (!batchIds.has(fromId) && !batchIds.has(toId)) continue;

      const normalized = normalizeConceptRelation({
        fromConceptId: fromId,
        toConceptId: toId,
        relationType: rel.type,
        bookId: null,
      });
      const key = relationIdentityKey(normalized);
      if (existingRelKeys.has(key)) continue;
      existingRelKeys.add(key);

      await db.insert(conceptRelations).values({
        fromConceptId: normalized.fromConceptId,
        toConceptId: normalized.toConceptId,
        relationType: normalized.relationType,
        evidence: rel.evidence,
        bookId: null,
        source: "llm",
      });
      totalNew++;
    }
  }

  return NextResponse.json({ ok: true, orphanCount: orphans.length, newRelations: totalNew });
}
