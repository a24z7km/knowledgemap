"use client";

import { useEffect, useState, useCallback, Suspense, useRef } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { BookOpen, ChevronDown, ExternalLink, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import type { Book } from "@/lib/db/schema";
import { RELATION_LABELS, relationColor, relationDash, relationLabel } from "@/lib/relations";
import { DOMAIN_LABELS, domainLabel } from "@/lib/domains";

const CytoscapeView = dynamic(() => import("@/components/graph/CytoscapeView"), {
  ssr: false,
  loading: () => <Skeleton className="w-full h-full" />,
});

interface GraphNode {
  id: number;
  name: string;
  aliases: string;
  domain: string;
  description: string | null;
  bookCount: number;
  bookIds: number[];
}

interface GraphEdge {
  id: number;
  fromConceptId: number;
  toConceptId: number;
  relationType: string;
  weight: number;
  evidence: string | null;
  bookId: number | null;
}

interface ConceptDetail {
  concept: { id: number; name: string; domain: string; description: string | null };
  appearances: { bookId: number; bookTitle: string; bookAuthor: string; importance: number; excerpt: string | null }[];
  relations: GraphEdge[];
}

interface BookSuggestion {
  title: string;
  author: string;
  reason: string;
  angle: string;
}

interface MapInsight {
  summary: string;
  keyIdeas: string[];
  developmentQuestions: string[];
  bookSuggestions: BookSuggestion[];
}

function MapContent() {
  const searchParams = useSearchParams();
  const highlightParam = searchParams.get("highlight");

  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [domain, setDomain] = useState("all");
  const [selectedBookIds, setSelectedBookIds] = useState<number[]>([]);
  const [bookPickerOpen, setBookPickerOpen] = useState(false);
  const [selected, setSelected] = useState<ConceptDetail | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<number[]>([]);
  const [insight, setInsight] = useState<MapInsight | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const [insightError, setInsightError] = useState<string | null>(null);
  const [lang, setLang] = useState<"en" | "ja">("ja");
  const [highlightId, setHighlightId] = useState<number | null>(
    highlightParam ? Number(highlightParam) : null
  );
  const pendingNodeIdRef = useRef<number | null>(null);

  const loadGraph = useCallback(() => {
    const params = new URLSearchParams();
    if (domain !== "all") params.set("domain", domain);
    fetch(`/api/graph?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.nodes) {
          setNodes(data.nodes);
          setEdges(data.edges);
        }
      });
  }, [domain]);

  useEffect(() => {
    loadGraph();
    fetch("/api/books").then((r) => r.json()).then(setBooks);
  }, [loadGraph]);

  // 解析中の本がある場合、完了したらグラフを自動更新する
  useEffect(() => {
    const isAnalyzing = books.some((b) => b.analyzeStatus === "analyzing");
    if (!isAnalyzing) return;
    const iv = setInterval(() => {
      fetch("/api/books")
        .then((r) => r.json())
        .then((updated: Book[]) => {
          setBooks(updated);
          const stillAnalyzing = updated.some((b) => b.analyzeStatus === "analyzing");
          if (!stillAnalyzing) {
            loadGraph();
            setSelected(null);
          }
        });
    }, 3000);
    return () => clearInterval(iv);
  }, [books, loadGraph]);

  const handleNodeClick = useCallback((nodeId: number) => {
    if (pendingNodeIdRef.current === nodeId) return;
    pendingNodeIdRef.current = nodeId;
    setHighlightId(nodeId);
    setInsightError(null);
    setSelectedLoading(true);
    setSelectedError(null);
    fetch(`/api/concepts/${nodeId}`)
      .then((r) => {
        if (!r.ok) throw new Error("概念の情報を取得できませんでした");
        return r.json();
      })
      .then((data) => {
        if (data?.concept) {
          setSelected(data);
        } else {
          throw new Error("概念の情報を取得できませんでした");
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : "通信エラーが発生しました";
        setSelected(null);
        setSelectedError(message);
        toast.error(message);
      })
      .finally(() => {
        if (pendingNodeIdRef.current === nodeId) pendingNodeIdRef.current = null;
        setSelectedLoading(false);
      });
  }, []);

  const handleSelectionChange = useCallback((nodeIds: number[]) => {
    setSelectedNodeIds(nodeIds);
    setInsight(null);
    setInsightError(null);
  }, []);

  const summarizeSelection = useCallback(() => {
    const conceptIds = selectedNodeIds.length > 0 ? selectedNodeIds : highlightId != null ? [highlightId] : [];
    if (conceptIds.length === 0) {
      toast.error("要約する概念を選択してください");
      return;
    }

    setInsightLoading(true);
    setInsightError(null);
    fetch("/api/map/insights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conceptIds }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("概要を生成できませんでした");
        return r.json();
      })
      .then((data: MapInsight) => setInsight(data))
      .catch((err) => {
        const message = err instanceof Error ? err.message : "概要の生成中にエラーが発生しました";
        setInsightError(message);
        toast.error(message);
      })
      .finally(() => setInsightLoading(false));
  }, [highlightId, selectedNodeIds]);

  const analyzedBooks = books.filter((b) => b.analyzeStatus === "done");
  const selectedBooks = analyzedBooks.filter((book) => selectedBookIds.includes(book.id));
  const highlightedNodeCount = selectedBookIds.length === 0
    ? 0
    : nodes.filter((node) => node.bookIds.some((bookId) => selectedBookIds.includes(bookId))).length;
  const bookTitleById = new Map(books.map((book) => [book.id, book.title]));

  const toggleBook = useCallback((bookId: number) => {
    setSelectedBookIds((current) =>
      current.includes(bookId)
        ? current.filter((id) => id !== bookId)
        : [...current, bookId]
    );
  }, []);

  useEffect(() => {
    if (highlightId != null && selected?.concept.id !== highlightId && !selectedLoading) {
      const timer = window.setTimeout(() => handleNodeClick(highlightId), 0);
      return () => window.clearTimeout(timer);
    }
  }, [highlightId, selected?.concept.id, selectedLoading, handleNodeClick]);

  return (
    <div className="flex h-full">
      {/* Graph */}
      <div className="flex-1 relative">
        {/* Filters */}
        <div className="absolute top-3 left-3 z-10 flex flex-wrap items-start gap-2 bg-background/90 backdrop-blur rounded-lg p-2 shadow-sm border max-w-[min(760px,calc(100%-1.5rem))]">
          <Select value={domain} onValueChange={(v) => setDomain(v ?? "all")}>
            <SelectTrigger className="w-36 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(DOMAIN_LABELS).map(([v, l]) => (
                <SelectItem key={v} value={v}>{l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-48 justify-between gap-2 text-xs font-normal"
              onClick={() => setBookPickerOpen((open) => !open)}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <BookOpen className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {selectedBookIds.length > 0 ? `${selectedBookIds.length}冊を表示` : "本を選択"}
                </span>
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </Button>

            {bookPickerOpen && (
              <div className="absolute left-0 top-9 z-20 w-72 rounded-lg border bg-popover p-2 shadow-md">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium">本</p>
                  {selectedBookIds.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedBookIds([])}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      解除
                    </button>
                  )}
                </div>
                <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                  {analyzedBooks.map((book) => {
                    const checked = selectedBookIds.includes(book.id);
                    return (
                      <label
                        key={book.id}
                        className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleBook(book.id)}
                          className="mt-0.5 h-3.5 w-3.5 accent-primary"
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{book.title}</span>
                          <span className="block truncate text-muted-foreground">{book.author}</span>
                        </span>
                      </label>
                    );
                  })}
                  {analyzedBooks.length === 0 && (
                    <p className="px-2 py-4 text-center text-xs text-muted-foreground">解析済みの本がありません</p>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="flex rounded-md border overflow-hidden h-8 text-xs">
            <button
              onClick={() => setLang("ja")}
              className={`px-2.5 ${lang === "ja" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              JA
            </button>
            <button
              onClick={() => setLang("en")}
              className={`px-2.5 ${lang === "en" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              EN
            </button>
          </div>

          {selectedBooks.length > 0 && (
            <div className="flex max-w-full flex-wrap items-center gap-1.5">
              {selectedBooks.slice(0, 4).map((book) => (
                <button
                  key={book.id}
                  type="button"
                  onClick={() => toggleBook(book.id)}
                  className="flex h-8 max-w-44 items-center gap-1 rounded-md border bg-muted px-2 text-xs"
                  title={book.title}
                >
                  <span className="truncate">{book.title}</span>
                  <X className="h-3 w-3 shrink-0 text-muted-foreground" />
                </button>
              ))}
              {selectedBooks.length > 4 && (
                <span className="text-xs text-muted-foreground">+{selectedBooks.length - 4}</span>
              )}
              <Badge variant="secondary" className="h-8 rounded-md">
                {highlightedNodeCount}点
              </Badge>
            </div>
          )}
        </div>

        {/* Legend */}
        <div className="absolute bottom-3 right-3 z-10 max-h-[46vh] w-52 overflow-y-auto bg-background/90 backdrop-blur rounded-lg p-2 shadow-sm border text-xs space-y-3">
          <div className="space-y-1">
            <p className="font-medium">関係の範囲</p>
            <div className="flex items-center gap-1.5">
              <svg width="28" height="10" className="shrink-0">
                <line x1="0" y1="5" x2="26" y2="5" stroke="#64748b" strokeWidth="2" />
              </svg>
              本内関係
            </div>
            <div className="flex items-center gap-1.5">
              <svg width="28" height="10" className="shrink-0">
                <line x1="0" y1="5" x2="26" y2="5" stroke="#0f172a" strokeWidth="3" strokeDasharray="1 3" />
              </svg>
              横断関係
            </div>
          </div>
          <div className="space-y-1">
            <p className="font-medium">関係タイプ</p>
            {Object.entries(RELATION_LABELS).map(([k, { label, color, dash }]) => (
              <div key={k} className="flex items-center gap-1.5">
                <svg width="16" height="10" className="shrink-0">
                  <line
                    x1="0" y1="5" x2="12" y2="5"
                    stroke={color} strokeWidth="2"
                    strokeDasharray={dash}
                  />
                  <polygon points="12,2 16,5 12,8" fill={color} />
                </svg>
                {label}
              </div>
            ))}
          </div>
        </div>

        {nodes.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            概念がありません。本を登録して解析してください。
          </div>
        ) : (
          <CytoscapeView
            nodes={nodes}
            edges={edges}
            highlightId={highlightId}
            onNodeClick={handleNodeClick}
            onSelectionChange={handleSelectionChange}
            lang={lang}
            selectedBookIds={selectedBookIds}
          />
        )}
      </div>

      {/* Detail panel */}
      <div className="w-80 border-l overflow-y-auto shrink-0 bg-background">
        <div className="border-b p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">選択範囲</p>
              <p className="text-xs text-muted-foreground">
                {selectedNodeIds.length > 0
                  ? `${selectedNodeIds.length}件の概念を選択中`
                  : highlightId != null
                    ? "1件の概念を選択中"
                    : "未選択"}
              </p>
            </div>
            <Button
              size="sm"
              onClick={summarizeSelection}
              disabled={insightLoading || (selectedNodeIds.length === 0 && highlightId == null)}
              className="h-8 gap-1.5"
            >
              <Sparkles className="h-3.5 w-3.5" />
              要約
            </Button>
          </div>

          {insightLoading && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}

          {insightError && (
            <p className="text-xs text-destructive">{insightError}</p>
          )}

          {insight && (
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs font-medium mb-1">概要</p>
                <p className="text-muted-foreground leading-relaxed">{insight.summary}</p>
              </div>

              {insight.keyIdeas.length > 0 && (
                <div>
                  <p className="text-xs font-medium mb-1">核になる考え</p>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {insight.keyIdeas.map((idea) => (
                      <li key={idea}>・{idea}</li>
                    ))}
                  </ul>
                </div>
              )}

              {insight.developmentQuestions.length > 0 && (
                <div>
                  <p className="text-xs font-medium mb-1">発展させる問い</p>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {insight.developmentQuestions.map((question) => (
                      <li key={question}>・{question}</li>
                    ))}
                  </ul>
                </div>
              )}

              {insight.bookSuggestions.length > 0 && (
                <div>
                  <p className="text-xs font-medium mb-2 flex items-center gap-1">
                    <BookOpen className="h-3.5 w-3.5" />
                    次に読む本
                  </p>
                  <div className="space-y-2">
                    {insight.bookSuggestions.map((book) => (
                      <div key={`${book.title}-${book.author}`} className="rounded-md border p-2 text-xs space-y-1">
                        <p className="font-medium">{book.title}</p>
                        <p className="text-muted-foreground">{book.author}</p>
                        <p>{book.angle}</p>
                        <p className="text-muted-foreground">{book.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {selectedLoading ? (
          <div className="p-4 space-y-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-16 w-full" />
            <Separator />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : selectedError ? (
          <div className="p-4 text-sm text-muted-foreground">
            {selectedError}
          </div>
        ) : selected ? (
          <div className="p-4 space-y-4">
            <div>
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">{selected.concept.name}</h2>
                <button
                  onClick={() => setSelected(null)}
                  className="text-muted-foreground hover:text-foreground text-lg leading-none"
                >
                  ×
                </button>
              </div>
              <Badge variant="secondary" className="text-xs mt-1">
                {domainLabel(selected.concept.domain)}
              </Badge>
              {selected.concept.description && (
                <p className="text-sm mt-2 text-muted-foreground">{selected.concept.description}</p>
              )}
            </div>

            <Separator />

            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-medium">参照元の本</p>
                <Badge variant="secondary" className="text-xs">{selected.appearances.length}冊</Badge>
              </div>
              {selected.appearances.length > 1 && (
                <p className="mb-2 text-xs text-muted-foreground">
                  複数の本で登場している概念です。
                </p>
              )}
              <div className="space-y-2">
                {selected.appearances.map((a) => (
                  <div key={a.bookId} className="rounded-md border p-2 text-xs space-y-1 hover:bg-muted/50 transition-colors">
                    <Link href={`/books/${a.bookId}`} className="font-medium hover:underline flex items-start justify-between gap-1">
                      <span>{a.bookTitle}</span>
                      <ExternalLink className="w-3 h-3 shrink-0 mt-0.5" />
                    </Link>
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-muted-foreground">{a.bookAuthor}</p>
                      <span className="shrink-0 text-yellow-500 tracking-tighter">
                        {"★".repeat(a.importance)}{"☆".repeat(5 - a.importance)}
                      </span>
                    </div>
                    {a.excerpt && (
                      <p className="italic border-l-2 pl-2 text-muted-foreground">{a.excerpt}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {selected.relations.length > 0 && (
              <>
                <Separator />
                <div>
                  <p className="text-xs font-medium mb-2">関係 ({selected.relations.length}件)</p>
                  <div className="space-y-2">
                    {selected.relations.map((r) => {
                      const otherId =
                        r.fromConceptId === selected.concept.id ? r.toConceptId : r.fromConceptId;
                      const otherNode = nodes.find((n) => n.id === otherId);
                      const isCrossBook = r.bookId == null;
                      const sourceBookTitle = r.bookId == null ? null : bookTitleById.get(r.bookId);
                      return (
                        <div
                          key={r.id}
                          className={`rounded-md border p-2 text-xs ${
                            isCrossBook ? "border-slate-300 bg-slate-50/70" : "hover:bg-muted/50"
                          }`}
                        >
                          <button
                            onClick={() => handleNodeClick(otherId)}
                            className="flex w-full items-center gap-2 text-left"
                          >
                            <RelationSwatch relationType={r.relationType} isCrossBook={isCrossBook} />
                            <span className="min-w-0 flex-1 truncate font-medium">{otherNode?.name ?? `#${otherId}`}</span>
                          </button>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline" className="text-xs">
                              {relationLabel(r.relationType)}
                            </Badge>
                            <Badge variant={isCrossBook ? "default" : "secondary"} className="text-xs">
                              {isCrossBook ? "横断関係" : "本内関係"}
                            </Badge>
                            {sourceBookTitle && (
                              <span className="min-w-0 truncate text-muted-foreground">
                                {sourceBookTitle}
                              </span>
                            )}
                          </div>
                          {r.evidence && (
                            <p className="mt-2 border-l-2 pl-2 text-muted-foreground">
                              {r.evidence}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
            ドットを選択すると、定義・参照元の本・関係がここに表示されます。
          </div>
        )}
      </div>
    </div>
  );
}

function RelationSwatch({ relationType, isCrossBook }: { relationType: string; isCrossBook: boolean }) {
  const color = relationColor(relationType);
  const dash = isCrossBook ? "1 3" : relationDash(relationType);
  return (
    <svg width="28" height="12" className="shrink-0">
      <line
        x1="0"
        y1="6"
        x2="22"
        y2="6"
        stroke={color}
        strokeWidth={isCrossBook ? 3 : 2}
        strokeDasharray={dash}
      />
      <polygon points="22,3 28,6 22,9" fill={color} />
    </svg>
  );
}

export default function MapPage() {
  return (
    <div className="h-full">
      <Suspense fallback={<Skeleton className="w-full h-full" />}>
        <MapContent />
      </Suspense>
    </div>
  );
}
