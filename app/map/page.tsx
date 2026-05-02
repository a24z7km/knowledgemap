"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { Book } from "@/lib/db/schema";

const CytoscapeView = dynamic(() => import("@/components/graph/CytoscapeView"), {
  ssr: false,
  loading: () => <Skeleton className="w-full h-full" />,
});

const DOMAIN_LABELS: Record<string, string> = {
  all: "全ドメイン",
  cybersec: "セキュリティ",
  finance: "金融",
  law: "法学",
  cs: "CS",
  math: "数学",
  general: "一般",
};

const RELATION_LABELS: Record<string, string> = {
  prerequisite: "前提",
  related: "関連",
  contradicts: "対立",
  extends: "拡張",
  applies_to: "適用",
};

interface GraphNode {
  id: number;
  name: string;
  domain: string;
  description: string | null;
  bookCount: number;
}

interface GraphEdge {
  id: number;
  fromConceptId: number;
  toConceptId: number;
  relationType: string;
  weight: number;
  evidence: string | null;
}

interface ConceptDetail {
  concept: { id: number; name: string; domain: string; description: string | null };
  appearances: { bookId: number; bookTitle: string; bookAuthor: string; importance: number; excerpt: string | null }[];
  relations: GraphEdge[];
}

function MapContent() {
  const searchParams = useSearchParams();
  const highlightParam = searchParams.get("highlight");

  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [domain, setDomain] = useState("all");
  const [bookFilter, setBookFilter] = useState("all");
  const [selected, setSelected] = useState<ConceptDetail | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(
    highlightParam ? Number(highlightParam) : null
  );

  const loadGraph = useCallback(() => {
    const params = new URLSearchParams();
    if (domain !== "all") params.set("domain", domain);
    if (bookFilter !== "all") params.set("bookId", bookFilter);
    fetch(`/api/graph?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.nodes) {
          setNodes(data.nodes);
          setEdges(data.edges);
        }
      });
  }, [domain, bookFilter]);

  useEffect(() => {
    loadGraph();
    fetch("/api/books").then((r) => r.json()).then(setBooks);
  }, [loadGraph]);

  const handleNodeClick = (nodeId: number) => {
    setHighlightId(nodeId);
    fetch(`/api/concepts/${nodeId}`)
      .then((r) => r.json())
      .then(setSelected);
  };

  return (
    <div className="flex h-full">
      {/* Graph */}
      <div className="flex-1 relative">
        {/* Filters */}
        <div className="absolute top-3 left-3 z-10 flex gap-2 bg-background/90 backdrop-blur rounded-lg p-2 shadow-sm border">
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
          <Select value={bookFilter} onValueChange={(v) => setBookFilter(v ?? "all")}>
            <SelectTrigger className="w-44 h-8 text-xs">
              <SelectValue placeholder="本でフィルタ" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全ての本</SelectItem>
              {books.filter((b) => b.analyzeStatus === "done").map((b) => (
                <SelectItem key={b.id} value={String(b.id)}>
                  {b.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Legend */}
        <div className="absolute bottom-3 left-3 z-10 bg-background/90 backdrop-blur rounded-lg p-2 shadow-sm border text-xs space-y-1">
          <p className="font-medium">エッジの種類</p>
          {Object.entries(RELATION_LABELS).map(([k, v]) => (
            <div key={k} className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-muted-foreground inline-block" />
              {v}
            </div>
          ))}
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
          />
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <div className="w-80 border-l overflow-y-auto shrink-0 bg-background">
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
                {DOMAIN_LABELS[selected.concept.domain] ?? selected.concept.domain}
              </Badge>
              {selected.concept.description && (
                <p className="text-sm mt-2 text-muted-foreground">{selected.concept.description}</p>
              )}
            </div>

            <Separator />

            <div>
              <p className="text-xs font-medium mb-2">出典 ({selected.appearances.length}冊)</p>
              <div className="space-y-2">
                {selected.appearances.map((a) => (
                  <div key={a.bookId} className="text-xs">
                    <Link href={`/books/${a.bookId}`} className="font-medium hover:underline flex items-center gap-1">
                      {a.bookTitle}
                      <ExternalLink className="w-3 h-3" />
                    </Link>
                    <p className="text-muted-foreground">{a.bookAuthor}</p>
                    {a.excerpt && (
                      <p className="mt-1 italic border-l-2 pl-2 text-muted-foreground">{a.excerpt}</p>
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
                  <div className="space-y-1">
                    {selected.relations.map((r) => {
                      const otherId =
                        r.fromConceptId === selected.concept.id ? r.toConceptId : r.fromConceptId;
                      const otherNode = nodes.find((n) => n.id === otherId);
                      return (
                        <button
                          key={r.id}
                          onClick={() => handleNodeClick(otherId)}
                          className="w-full text-left text-xs hover:bg-muted rounded px-2 py-1 flex items-center gap-2"
                        >
                          <Badge variant="outline" className="text-xs shrink-0">
                            {RELATION_LABELS[r.relationType] ?? r.relationType}
                          </Badge>
                          <span className="truncate">{otherNode?.name ?? `#${otherId}`}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
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
