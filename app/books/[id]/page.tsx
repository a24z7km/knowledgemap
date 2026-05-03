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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft, Play, Trash2, Brain, Square,
  RefreshCw, X, Plus, Globe, BookOpen, User, Pencil, Check,
} from "lucide-react";
import type { Book, ExtractionRun, BookKeywordDraft } from "@/lib/db/schema";
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

const MODEL_OPTIONS = [
  { value: "gpt-4o-mini",  label: "gpt-4o-mini  〜0.5円/冊" },
  { value: "gpt-4.1-mini", label: "gpt-4.1-mini  〜1円/冊" },
  { value: "o3-mini",      label: "o3-mini  〜3円/冊" },
  { value: "gpt-4.1",      label: "gpt-4.1  〜6円/冊" },
  { value: "gpt-4o",       label: "gpt-4o  〜7円/冊" },
  { value: "o3",           label: "o3  〜50円/冊" },
];

const SOURCE_LABELS: Record<string, string> = {
  web_search:   "Web検索",
  book_db:      "書誌DB",
  user_toc:     "あなたの目次",
  user_summary: "あなたの要約",
  user_input:   "手動追加",
};

const SOURCE_ICON: Record<string, React.ReactNode> = {
  web_search:   <Globe className="w-3 h-3" />,
  book_db:      <BookOpen className="w-3 h-3" />,
  user_toc:     <User className="w-3 h-3" />,
  user_summary: <User className="w-3 h-3" />,
  user_input:   <User className="w-3 h-3" />,
};

/* ─────────────── ModelSelect ─────────────── */
function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger className="h-7 text-xs w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MODEL_OPTIONS.map((m) => (
          <SelectItem key={m.value} value={m.value} className="text-xs">
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* ─────────────── EditableDraft ─────────────── */
function EditableDraft({
  draft,
  onDelete,
  onUpdate,
}: {
  draft: BookKeywordDraft;
  onDelete: (id: number) => void;
  onUpdate: (id: number, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(draft.text);

  const commit = () => {
    if (value.trim() && value.trim() !== draft.text) onUpdate(draft.id, value.trim());
    setEditing(false);
  };

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-primary px-2 py-0.5 text-xs bg-background">
        <input
          autoFocus
          className="outline-none bg-transparent w-48 min-w-0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        />
        <button onClick={commit} className="text-primary ml-1"><Check className="w-2.5 h-2.5" /></button>
        <button onClick={() => setEditing(false)} className="text-muted-foreground"><X className="w-2.5 h-2.5" /></button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs bg-muted/40 group">
      <span className="max-w-[240px] truncate">{draft.text}</span>
      <button
        onClick={() => setEditing(true)}
        className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 ml-1"
      >
        <Pencil className="w-2.5 h-2.5" />
      </button>
      <button
        onClick={() => onDelete(draft.id)}
        className="text-muted-foreground hover:text-destructive"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </span>
  );
}

/* ─────────────── Page ─────────────── */
export default function BookDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [book, setBook] = useState<Book | null>(null);
  const [concepts, setConcepts] = useState<ConceptRow[]>([]);
  const [latestExtractionRun, setLatestExtractionRun] = useState<ExtractionRun | null>(null);
  const [drafts, setDrafts] = useState<BookKeywordDraft[]>([]);

  const [step1Model, setStep1Model] = useState("gpt-4o-mini");
  const [step2Model, setStep2Model] = useState("gpt-4o-mini");
  const [step1Running, setStep1Running] = useState(false);

  const [sourceForm, setSourceForm] = useState({
    notes: "", userToc: "", userSummary: "", userKeywords: "", userQuotes: "",
  });
  const sourceDirtyRef = useRef(false);
  const [savingSource, setSavingSource] = useState(false);
  const [newDraftText, setNewDraftText] = useState("");

  /* ── loaders ── */
  const loadDrafts = useCallback(async () => {
    const res = await fetch(`/api/books/${id}/drafts`);
    if (res.ok) setDrafts(await res.json());
  }, [id]);

  const load = useCallback(() =>
    fetch(`/api/books/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.book) return;
        setBook(data.book);
        setConcepts(data.concepts ?? []);
        setLatestExtractionRun(data.latestExtractionRun ?? null);
        if (!sourceDirtyRef.current) {
          setSourceForm({
            notes:       data.book.notes        ?? "",
            userToc:     data.book.userToc      ?? "",
            userSummary: data.book.userSummary  ?? "",
            userKeywords:data.book.userKeywords ?? "",
            userQuotes:  data.book.userQuotes   ?? "",
          });
        }
      }), [id]);

  useEffect(() => {
    load();
    loadDrafts();
    const iv = setInterval(load, 3000);
    return () => clearInterval(iv);
  }, [id, load, loadDrafts]);

  /* ── persist ── */
  const persistSourceFields = async () => {
    const res = await fetch(`/api/books/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sourceForm),
    });
    if (!res.ok) throw new Error(await res.text());
  };

  const saveSourceFields = async () => {
    setSavingSource(true);
    try {
      await persistSourceFields();
      toast.success("保存しました");
      sourceDirtyRef.current = false;
      load();
    } catch (err) { toast.error(String(err)); }
    finally { setSavingSource(false); }
  };

  /* ── Step 1 ── */
  const runStep1 = async (clear = false) => {
    setStep1Running(true);
    try {
      await persistSourceFields();
      // フォームは保存済みだが上書きしたくないので dirty を維持
      sourceDirtyRef.current = true;
      const res = await fetch(`/api/books/${id}/step1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear, model: step1Model }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as {
        count: number;
        suggestedToc?: string;
        suggestedSummary?: string;
        suggestedKeywords?: string;
      };

      // フィールドが空のときだけ LLM 収集データを自動入力
      setSourceForm((prev) => {
        const next = { ...prev };
        let changed = false;
        if (!prev.userToc.trim() && data.suggestedToc) { next.userToc = data.suggestedToc; changed = true; }
        if (!prev.userSummary.trim() && data.suggestedSummary) { next.userSummary = data.suggestedSummary; changed = true; }
        if (!prev.userKeywords.trim() && data.suggestedKeywords) { next.userKeywords = data.suggestedKeywords; changed = true; }
        if (changed) {
          // stale closure を避けるため next の値で直接 PATCH
          fetch(`/api/books/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(next),
          }).catch(() => undefined);
        }
        return next;
      });

      toast.success(`Step 1 完了: ${data.count} 件収集しました`);
      await load();
      await loadDrafts();
    } catch (err) { toast.error(String(err)); }
    finally { setStep1Running(false); }
  };

  /* ── Step 2 ── */
  const runStep2 = async () => {
    const res = await fetch(`/api/analyze/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: step2Model }),
    });
    if (res.ok) { toast.info("Step 2: 概念抽出を開始しました..."); load(); }
    else toast.error("解析の開始に失敗しました");
  };

  const cancelAnalysis = async () => {
    const res = await fetch(`/api/analyze/${id}/cancel`, { method: "POST" });
    if (res.ok) { toast.info("解析を停止しました"); load(); }
  };

  /* ── drafts CRUD ── */
  const deleteDraft = async (draftId: number) => {
    const res = await fetch(`/api/books/${id}/drafts`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId }),
    });
    if (res.ok) setDrafts((prev) => prev.filter((d) => d.id !== draftId));
    else toast.error("削除に失敗しました");
  };

  const updateDraft = async (draftId: number, text: string) => {
    const res = await fetch(`/api/books/${id}/drafts/${draftId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      const updated = await res.json();
      setDrafts((prev) => prev.map((d) => d.id === draftId ? updated : d));
    } else toast.error("更新に失敗しました");
  };

  const addDraft = async () => {
    const text = newDraftText.trim();
    if (!text) return;
    const res = await fetch(`/api/books/${id}/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, source: "user_input" }),
    });
    if (!res.ok) { toast.error("追加に失敗しました"); return; }
    const draft = await res.json();
    setDrafts((prev) => [...prev, draft]);
    setNewDraftText("");
  };

  const remove = async () => {
    if (!confirm(`「${book?.title}」を削除しますか?`)) return;
    await fetch(`/api/books/${id}`, { method: "DELETE" });
    toast.success("削除しました");
    router.push("/books");
  };

  /* ── render ── */
  if (!book) return <div className="p-6 text-sm text-muted-foreground">読み込み中...</div>;

  const isAnalyzing = book.analyzeStatus === "analyzing";
  const isAnalyzeFailed = book.analyzeStatus === "error" || book.analyzeStatus === "failed";
  const step1Done = Boolean(book.step1CompletedAt);

  const draftsBySource = drafts.reduce<Record<string, BookKeywordDraft[]>>((acc, d) => {
    (acc[d.source] ??= []).push(d);
    return acc;
  }, {});

  const sourceOrder = ["book_db", "web_search", "user_toc", "user_summary", "user_input"];

  return (
    <div className="max-w-screen-lg mx-auto px-4 py-6 pb-20 space-y-6">

      {/* ── Header ── */}
      <div className="flex items-center gap-3">
        <Link href="/books">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold truncate">{book.title}</h1>
          <p className="text-sm text-muted-foreground">{book.author}</p>
        </div>
        <Button variant="destructive" size="sm" onClick={remove}>
          <Trash2 className="w-3 h-3 mr-1" /> 削除
        </Button>
      </div>

      {/* ── Step 2 analyzing banner ── */}
      {isAnalyzing && (
        <Card className="border-blue-200 bg-blue-50">
          <CardContent className="py-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-blue-700 text-sm">
                <Brain className="w-4 h-4 animate-pulse" />
                概念と関係を抽出中...
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
          <CardContent className="py-3 text-sm text-red-700 space-y-1">
            <p className="font-medium">{analysisErrorTitle(book.analyzeError)}</p>
            <p>{analysisErrorMessage(book.analyzeError)}</p>
            {book.analyzeError === "insufficient_source" && (
              <p className="text-xs">{formatSourceQualityHint(latestExtractionRun)} → 目次や要約を入力してください</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ══════════════════════════════════════
           STEP 1: キーワード収集
         ══════════════════════════════════════ */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
              <span className="font-bold text-xs bg-muted px-2 py-0.5 rounded">Step 1</span>
              キーワード収集
              {step1Done && <span className="text-xs text-green-600 font-normal">✓ 完了</span>}
              {book.step1CompletedAt && (
                <span className="text-[10px] text-muted-foreground font-normal">
                  {fmtDate(book.step1CompletedAt)}
                  {book.step1Model && <> · {book.step1Model}</>}
                </span>
              )}
            </CardTitle>

            <div className="flex flex-wrap items-center gap-2">
              <ModelSelect value={step1Model} onChange={setStep1Model} />
              <Button
                size="sm"
                variant={step1Done ? "outline" : "default"}
                disabled={step1Running}
                onClick={() => runStep1(false)}
              >
                {step1Running
                  ? <><RefreshCw className="w-3 h-3 mr-1 animate-spin" />収集中...</>
                  : step1Done
                    ? <><RefreshCw className="w-3 h-3 mr-1" />差分追加</>
                    : <><Play className="w-3 h-3 mr-1" />Step 1 を実行</>}
              </Button>
              {step1Done && (
                <Button size="sm" variant="ghost" disabled={step1Running} onClick={() => runStep1(true)}
                  className="text-muted-foreground text-xs">
                  再収集(クリア)
                </Button>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* ─ ユーザー入力フォーム ─ */}
          <div className="space-y-3">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
              あなたの入力（任意・Step 1 実行時に取り込まれます）
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1 md:col-span-2">
                <Label htmlFor="userToc" className="text-xs">目次を貼り付け</Label>
                <Textarea id="userToc" rows={6}
                  value={sourceForm.userToc}
                  onChange={(e) => { sourceDirtyRef.current = true; setSourceForm((f) => ({ ...f, userToc: e.target.value })); }}
                  placeholder={"第1章 ...\n第2章 ..."}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="userSummary" className="text-xs">要約・感想</Label>
                <Textarea id="userSummary" rows={5}
                  value={sourceForm.userSummary}
                  onChange={(e) => { sourceDirtyRef.current = true; setSourceForm((f) => ({ ...f, userSummary: e.target.value })); }}
                  placeholder="この本の主張、印象に残った内容..."
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="userKeywords" className="text-xs">気になったキーワード（カンマ区切り）</Label>
                <Textarea id="userKeywords" rows={5}
                  value={sourceForm.userKeywords}
                  onChange={(e) => { sourceDirtyRef.current = true; setSourceForm((f) => ({ ...f, userKeywords: e.target.value })); }}
                  placeholder="習慣, 潜在意識, 行動変容..."
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label htmlFor="userQuotes" className="text-xs">印象的な引用</Label>
                <Textarea id="userQuotes" rows={3}
                  value={sourceForm.userQuotes}
                  onChange={(e) => { sourceDirtyRef.current = true; setSourceForm((f) => ({ ...f, userQuotes: e.target.value })); }}
                  placeholder="「...」"
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label htmlFor="notes" className="text-xs">メモ</Label>
                <Textarea id="notes" rows={3}
                  value={sourceForm.notes}
                  onChange={(e) => { sourceDirtyRef.current = true; setSourceForm((f) => ({ ...f, notes: e.target.value })); }}
                  placeholder="引用、気づき、あとで確認したい点..."
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={saveSourceFields} disabled={savingSource}>
                {savingSource ? "保存中..." : "保存"}
              </Button>
            </div>
          </div>

          {/* ─ 収集済みキーワード ─ */}
          {drafts.length > 0 && (
            <div className="space-y-4 pt-2 border-t">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                収集済みキーワード（{drafts.length} 件）— クリックで編集、×で削除
              </p>

              {sourceOrder
                .filter((s) => draftsBySource[s]?.length)
                .map((source) => (
                  <div key={source} className="space-y-2">
                    <p className="text-xs flex items-center gap-1 text-muted-foreground font-medium">
                      {SOURCE_ICON[source]}
                      {SOURCE_LABELS[source] ?? source}
                      <span className="text-muted-foreground/60">({draftsBySource[source].length})</span>
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {draftsBySource[source].map((d) => (
                        <EditableDraft key={d.id} draft={d} onDelete={deleteDraft} onUpdate={updateDraft} />
                      ))}
                    </div>
                  </div>
                ))}

              {/* 手動追加 */}
              <div className="flex gap-2 pt-1">
                <Input
                  value={newDraftText}
                  onChange={(e) => setNewDraftText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addDraft(); }}
                  placeholder="キーワードを手動追加..."
                  className="text-sm h-8"
                />
                <Button size="sm" variant="outline" disabled={!newDraftText.trim()} onClick={addDraft}>
                  <Plus className="w-3 h-3" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ══════════════════════════════════════
           STEP 2: 概念抽出
         ══════════════════════════════════════ */}
      <Card className={!step1Done ? "opacity-60" : ""}>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
              <span className="font-bold text-xs bg-muted px-2 py-0.5 rounded">Step 2</span>
              概念・関係の抽出
              {book.analyzeStatus === "done" && <span className="text-xs text-green-600 font-normal">✓ 完了</span>}
              {latestExtractionRun?.completedAt && (
                <span className="text-[10px] text-muted-foreground font-normal">
                  {fmtDate(latestExtractionRun.completedAt)}
                  {latestExtractionRun.model && <> · {latestExtractionRun.model}</>}
                </span>
              )}
            </CardTitle>

            <div className="flex flex-wrap items-center gap-2">
              <ModelSelect value={step2Model} onChange={setStep2Model} />
              <Button
                size="sm"
                disabled={isAnalyzing || !step1Done}
                onClick={runStep2}
              >
                {isAnalyzing
                  ? <><Brain className="w-3 h-3 mr-1 animate-pulse" />抽出中...</>
                  : book.analyzeStatus === "done"
                    ? <><RefreshCw className="w-3 h-3 mr-1" />再抽出</>
                    : <><Brain className="w-3 h-3 mr-1" />Step 2 を実行</>}
              </Button>
            </div>
          </div>
          {!step1Done && (
            <p className="text-xs text-muted-foreground mt-1">Step 1 を完了してから実行してください</p>
          )}
        </CardHeader>

        {concepts.length > 0 && (
          <CardContent>
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              {[...concepts]
                .sort((a, b) => b.importance - a.importance)
                .map((c) => (
                  <div key={c.id}>
                    <div className="flex items-start gap-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${domainBadgeClass(c.conceptDomain)}`}>
                        {c.conceptDomain}
                      </span>
                      <div className="flex-1 min-w-0">
                        <Link href={`/map?highlight=${c.conceptId}`} className="text-sm font-medium hover:underline">
                          {c.conceptName}
                        </Link>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {conceptMetadataLabels(c).map((label, i) => (
                            <span key={i} className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {label}
                            </span>
                          ))}
                        </div>
                        {c.conceptDescription && (
                          <p className="text-xs text-muted-foreground mt-0.5">{c.conceptDescription}</p>
                        )}
                        {c.excerpt && (
                          <p className="text-xs text-muted-foreground mt-1 italic border-l-2 pl-2">{c.excerpt}</p>
                        )}
                      </div>
                      <div className="flex gap-0.5 shrink-0">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <div key={i} className={`w-1.5 h-1.5 rounded-full ${i < c.importance ? "bg-foreground" : "bg-muted"}`} />
                        ))}
                      </div>
                    </div>
                    <Separator className="mt-3" />
                  </div>
                ))}
            </div>
          </CardContent>
        )}
      </Card>

    </div>
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatSourceQualityHint(run: ExtractionRun | null) {
  const fallback = "description: 0文字, TOC: 0行, subjects: 0個";
  if (!run?.sourceStats) return fallback;
  try {
    const stats = JSON.parse(run.sourceStats) as {
      sourceQuality?: { descriptionChars?: number; tocLines?: number; subjectsCount?: number } | null;
    };
    const q = stats.sourceQuality;
    if (!q) return fallback;
    return `description: ${q.descriptionChars ?? 0}文字, TOC: ${q.tocLines ?? 0}行, subjects: ${q.subjectsCount ?? 0}個`;
  } catch { return fallback; }
}
