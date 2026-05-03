"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Play, Trash2, Brain, Square } from "lucide-react";
import type { Book, ExtractionRun } from "@/lib/db/schema";
import { domainBadgeClass } from "@/lib/domains";
import { conceptMetadataLabels } from "@/lib/concept-metadata";
import { analysisErrorMessage, analysisErrorTitle } from "@/lib/analysis-errors";

interface ConceptRow {
  id: number;
  conceptId: number;
  conceptName: string;
  conceptDomain: string;
  conceptDescription: string | null;
  importance: number;
  excerpt: string | null;
  conceptLevel?: string | null;
  conceptType?: string | null;
  specificity?: string | null;
}

export default function BookDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [book, setBook] = useState<Book | null>(null);
  const [concepts, setConcepts] = useState<ConceptRow[]>([]);
  const [latestExtractionRun, setLatestExtractionRun] = useState<ExtractionRun | null>(null);
  const [sourceForm, setSourceForm] = useState({ notes: "", userToc: "", userSummary: "" });
  const sourceDirtyRef = useRef(false);
  const [savingSource, setSavingSource] = useState(false);

  const load = useCallback(() =>
    fetch(`/api/books/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.book) {
          setBook(data.book);
          setConcepts(data.concepts ?? []);
          setLatestExtractionRun(data.latestExtractionRun ?? null);
          if (!sourceDirtyRef.current) {
            setSourceForm({
              notes: data.book.notes ?? "",
              userToc: data.book.userToc ?? "",
              userSummary: data.book.userSummary ?? "",
            });
          }
        }
      }), [id]);

  useEffect(() => {
    load();
    const iv = setInterval(() => {
      load();
    }, 3000);
    return () => clearInterval(iv);
  }, [id, load]);

  const analyze = async () => {
    const res = await fetch(`/api/analyze/${id}`, { method: "POST" });
    if (res.ok) {
      toast.info("解析を開始しました...");
      load();
    }
  };

  const saveSourceFields = async () => {
    setSavingSource(true);
    try {
      await persistSourceFields();
      toast.success("解析用ソースを保存しました");
      sourceDirtyRef.current = false;
      load();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSavingSource(false);
    }
  };

  const persistSourceFields = async () => {
    const res = await fetch(`/api/books/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sourceForm),
    });
    if (!res.ok) throw new Error(await res.text());
  };

  const saveSourceFieldsAndAnalyze = async () => {
    setSavingSource(true);
    try {
      await persistSourceFields();
      sourceDirtyRef.current = false;
      await analyze();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSavingSource(false);
    }
  };

  const cancelAnalysis = async () => {
    const res = await fetch(`/api/analyze/${id}/cancel`, { method: "POST" });
    if (res.ok) {
      toast.info("解析を停止しました");
      load();
    }
  };

  const remove = async () => {
    if (!confirm(`「${book?.title}」を削除しますか?`)) return;
    await fetch(`/api/books/${id}`, { method: "DELETE" });
    toast.success("削除しました");
    router.push("/books");
  };

  if (!book) return <div className="p-6 text-sm text-muted-foreground">読み込み中...</div>;

  const isAnalyzing = book.analyzeStatus === "analyzing";
  const isAnalyzeFailed = book.analyzeStatus === "error" || book.analyzeStatus === "failed";

  return (
    <div className="max-w-screen-lg mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/books">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold truncate">{book.title}</h1>
          <p className="text-sm text-muted-foreground">{book.author}</p>
        </div>
        <div className="flex gap-2">
          {(book.analyzeStatus === "pending" || isAnalyzeFailed) && (
            <Button size="sm" onClick={analyze}>
              <Play className="w-3 h-3 mr-1" /> 解析する
            </Button>
          )}
          <Button variant="destructive" size="sm" onClick={remove}>
            <Trash2 className="w-3 h-3 mr-1" /> 削除
          </Button>
        </div>
      </div>

      {isAnalyzing && (
        <Card className="border-blue-200 bg-blue-50">
          <CardContent className="py-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-blue-700 text-sm">
                <Brain className="w-4 h-4 animate-pulse" />
                LLMが概念と関係を抽出中です...
              </div>
              <Button variant="outline" size="sm" onClick={cancelAnalysis}>
                <Square className="w-3 h-3 mr-1" /> 停止
              </Button>
            </div>
            <Progress value={null} className="h-1.5" />
          </CardContent>
        </Card>
      )}

      {isAnalyzeFailed && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-3 text-sm text-red-700 space-y-2">
            <p className="font-medium">{analysisErrorTitle(book.analyzeError)}</p>
            <p>{analysisErrorMessage(book.analyzeError)}</p>
            {book.analyzeError === "insufficient_source" && (
              <p className="text-xs">
                {formatSourceQualityHint(latestExtractionRun)} → 目次や要約を入力してください
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">解析用ソース</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="userToc">目次を貼り付け</Label>
              <Textarea
                id="userToc"
                rows={7}
                value={sourceForm.userToc}
                onChange={(e) => {
                  sourceDirtyRef.current = true;
                  setSourceForm((form) => ({ ...form, userToc: e.target.value }));
                }}
                placeholder={"第1章 ...\n第2章 ..."}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="userSummary">自分で書いた要約・読了後感想</Label>
              <Textarea
                id="userSummary"
                rows={6}
                value={sourceForm.userSummary}
                onChange={(e) => {
                  sourceDirtyRef.current = true;
                  setSourceForm((form) => ({ ...form, userSummary: e.target.value }));
                }}
                placeholder="この本の主張、印象に残った内容、重要だと思った概念..."
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="notes">メモ</Label>
              <Textarea
                id="notes"
                rows={6}
                value={sourceForm.notes}
                onChange={(e) => {
                  sourceDirtyRef.current = true;
                  setSourceForm((form) => ({ ...form, notes: e.target.value }));
                }}
                placeholder="引用、気づき、あとで確認したい点..."
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={saveSourceFields} disabled={savingSource}>
              {savingSource ? "保存中..." : "保存"}
            </Button>
            <Button size="sm" onClick={saveSourceFieldsAndAnalyze} disabled={isAnalyzing || savingSource}>
              <Play className="w-3 h-3 mr-1" /> 保存内容で解析
            </Button>
          </div>
        </CardContent>
      </Card>

      {(book.notes || book.userToc || book.userSummary) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">保存済みソース</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {book.userToc && (
              <SourcePreview title="目次" text={book.userToc} />
            )}
            {book.userSummary && (
              <SourcePreview title="要約・感想" text={book.userSummary} />
            )}
            {book.notes && (
              <SourcePreview title="メモ" text={book.notes} />
            )}
          </CardContent>
        </Card>
      )}

      {concepts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Brain className="w-4 h-4" />
              抽出された概念 ({concepts.length}件)
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-y-auto max-h-[60vh]">
            <div className="space-y-3">
              {concepts
                .sort((a, b) => b.importance - a.importance)
                .map((c) => (
                  <div key={c.id}>
                    <div className="flex items-start gap-2">
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded font-medium ${domainBadgeClass(c.conceptDomain)}`}
                      >
                        {c.conceptDomain}
                      </span>
                      <div className="flex-1 min-w-0">
                        <Link
                          href={`/map?highlight=${c.conceptId}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {c.conceptName}
                        </Link>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {conceptMetadataLabels(c).map((label, i) => (
                            <span key={i} className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {label}
                            </span>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {c.conceptDescription}
                        </p>
                        {c.excerpt && (
                          <p className="text-xs text-muted-foreground mt-1 italic border-l-2 pl-2">
                            {c.excerpt}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-0.5 shrink-0">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <div
                            key={i}
                            className={`w-1.5 h-1.5 rounded-full ${
                              i < c.importance ? "bg-foreground" : "bg-muted"
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                    <Separator className="mt-3" />
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SourcePreview({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p className="mt-1 text-sm whitespace-pre-wrap">{text}</p>
    </div>
  );
}

function formatSourceQualityHint(run: ExtractionRun | null) {
  const fallback = "description: 0文字, TOC: 0行, subjects: 0個";
  if (!run?.sourceStats) return fallback;
  try {
    const stats = JSON.parse(run.sourceStats) as {
      sourceQuality?: {
        descriptionChars?: number;
        tocLines?: number;
        subjectsCount?: number;
      } | null;
    };
    const quality = stats.sourceQuality;
    if (!quality) return fallback;
    return `description: ${quality.descriptionChars ?? 0}文字, TOC: ${quality.tocLines ?? 0}行, subjects: ${quality.subjectsCount ?? 0}個`;
  } catch {
    return fallback;
  }
}
