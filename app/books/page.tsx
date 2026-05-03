"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, Plus, Trash2, Play, Link as LinkIcon, Upload, CheckSquare, Square } from "lucide-react";
import type { Book, ExtractionRun } from "@/lib/db/schema";
import { analysisErrorMessage, analysisErrorTitle } from "@/lib/analysis-errors";

const STATUS_MAP = {
  read: { label: "読了", color: "default" as const },
  reading: { label: "読書中", color: "secondary" as const },
  want: { label: "積読", color: "outline" as const },
};

const ANALYZE_MAP = {
  pending: { label: "未解析", color: "secondary" as const },
  analyzing: { label: "解析中...", color: "default" as const },
  done: { label: "解析済", color: "default" as const },
  error: { label: "エラー", color: "destructive" as const },
  failed: { label: "エラー", color: "destructive" as const },
};

const EXTRACTION_RUN_STATUS_LABELS: Record<ExtractionRun["status"], string> = {
  running: "実行中",
  completed: "完了",
  failed: "失敗",
  cancelled: "中止",
};

type Tab = "manual" | "url" | "csv";

const EMPTY_FORM = { title: "", author: "", readStatus: "read", notes: "" };

interface BookListItem extends Book {
  latestExtractionRun?: ExtractionRun | null;
}

export default function BooksPage() {
  const [books, setBooks] = useState<BookListItem[]>([]);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("manual");
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // URL tab state
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState(false);

  // CSV tab state
  const fileRef = useRef<HTMLInputElement>(null);
  const [csvRows, setCsvRows] = useState<typeof EMPTY_FORM[]>([]);
  const [csvImporting, setCsvImporting] = useState(false);

  // Model selection
  const [model, setModel] = useState("gpt-4o-mini");

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkAnalyzing, setBulkAnalyzing] = useState(false);

  const toggleSelect = (id: number) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const selectAll = () => {
    const analyzable = books.filter((b) => b.analyzeStatus !== "analyzing").map((b) => b.id);
    if (selectedIds.size === analyzable.length && analyzable.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(analyzable));
    }
  };

  const analyzeSelected = async () => {
    const targets = books.filter((b) => selectedIds.has(b.id) && b.analyzeStatus !== "analyzing");
    if (targets.length === 0) return;
    setBulkAnalyzing(true);
    setSelectedIds(new Set());
    for (const book of targets) {
      await fetch(`/api/analyze/${book.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      toast.info(`「${book.title}」の解析を開始`);
      load();
      // brief pause between requests
      await new Promise((r) => setTimeout(r, 300));
    }
    setBulkAnalyzing(false);
  };

  const load = () =>
    fetch("/api/books")
      .then((r) => r.json())
      .then(setBooks);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, []);

  const resetDialog = () => {
    setTab("manual");
    setForm(EMPTY_FORM);
    setUrl("");
    setFetched(false);
    setCsvRows([]);
  };

  // ── Manual submit ──────────────────────────────────────────────
  const submitManual = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`「${form.title}」を登録しました`);
      setOpen(false);
      resetDialog();
      load();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  };

  // ── URL fetch ──────────────────────────────────────────────────
  const fetchUrl = async () => {
    if (!url) return;
    setFetching(true);
    setFetched(false);
    try {
      const res = await fetch("/api/books/fetch-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setForm((f) => ({ ...f, title: data.title, author: data.author }));
      setFetched(true);
      toast.success("書籍情報を取得しました");
    } catch (err) {
      toast.error(String(err));
    } finally {
      setFetching(false);
    }
  };

  const submitUrl = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`「${form.title}」を登録しました`);
      setOpen(false);
      resetDialog();
      load();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  };

  // ── CSV parse ──────────────────────────────────────────────────
  const handleCsvFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.trim().split("\n");
      const header = lines[0].toLowerCase().replace(/\r/g, "");
      const hasHeader = header.includes("title") || header.includes("タイトル");
      const dataLines = hasHeader ? lines.slice(1) : lines;

      const rows = dataLines.map((line) => {
        // Simple CSV parse (handles quoted fields)
        const cols = parseCsvLine(line.replace(/\r/g, ""));
        return {
          title: cols[0] ?? "",
          author: cols[1] ?? "",
          readStatus: (["read", "reading", "want"].includes(cols[2]) ? cols[2] : "read") as "read" | "reading" | "want",
          notes: cols[3] ?? "",
        };
      }).filter((r) => r.title);

      setCsvRows(rows);
    };
    reader.readAsText(file, "UTF-8");
  };

  const submitCsv = async () => {
    if (csvRows.length === 0) return;
    setCsvImporting(true);
    try {
      let count = 0;
      for (const row of csvRows) {
        const res = await fetch("/api/books", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(row),
        });
        if (res.ok) count++;
      }
      toast.success(`${count}冊を登録しました`);
      setOpen(false);
      resetDialog();
      load();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setCsvImporting(false);
    }
  };

  // ── Analyze / Delete ───────────────────────────────────────────
  const analyze = async (book: BookListItem) => {
    const res = await fetch(`/api/analyze/${book.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (res.ok) {
      toast.info(`「${book.title}」の解析を開始しました（${model}）`);
      load();
    }
  };

  const remove = async (book: BookListItem) => {
    if (!confirm(`「${book.title}」を削除しますか?`)) return;
    await fetch(`/api/books/${book.id}`, { method: "DELETE" });
    toast.success("削除しました");
    load();
  };

  const exportCsv = () => {
    window.location.href = "/api/export/csv";
  };

  return (
    <div className="max-w-screen-xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">本一覧</h1>
        <div className="flex items-center gap-2 ml-auto flex-wrap">
          <Select value={model} onValueChange={(v) => setModel(v ?? "gpt-4o-mini")}>
            <SelectTrigger className="w-56 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gpt-4o-mini">gpt-4o-mini　〜0.5円/冊</SelectItem>
              <SelectItem value="gpt-4.1-mini">gpt-4.1-mini　〜1円/冊</SelectItem>
              <SelectItem value="o4-mini">o4-mini　〜3円/冊</SelectItem>
              <SelectItem value="o3-mini">o3-mini　〜3円/冊</SelectItem>
              <SelectItem value="gpt-4.1">gpt-4.1　〜6円/冊</SelectItem>
              <SelectItem value="gpt-4o">gpt-4o　〜7円/冊</SelectItem>
              <SelectItem value="o3">o3　〜50円/冊</SelectItem>
            </SelectContent>
          </Select>
          {books.length > 0 && (
            <Button variant="outline" size="sm" onClick={selectAll} className="gap-1.5">
              {selectedIds.size === books.filter((b) => b.analyzeStatus !== "analyzing").length && books.length > 0
                ? <CheckSquare className="w-4 h-4" />
                : <Square className="w-4 h-4" />}
              {selectedIds.size === 0 ? "全選択" : `${selectedIds.size}冊選択中`}
            </Button>
          )}
          {selectedIds.size > 0 && (
            <Button size="sm" onClick={analyzeSelected} disabled={bulkAnalyzing} className="gap-1.5">
              <Play className="w-4 h-4" />
              {bulkAnalyzing ? "解析中..." : `選択した${selectedIds.size}冊を解析`}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={exportCsv} className="gap-1.5">
            <Download className="w-4 h-4" />
            CSV
          </Button>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetDialog(); }}>
          <DialogTrigger render={<Button size="sm" />}>
            <Plus className="w-4 h-4 mr-1" /> 本を追加
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>本を登録</DialogTitle>
            </DialogHeader>

            {/* Tab switcher */}
            <div className="flex rounded-md border overflow-hidden text-sm mt-1">
              {([["manual", "手動入力"], ["url", "URLから取得"], ["csv", "CSVインポート"]] as [Tab, string][]).map(([t, label]) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex-1 py-1.5 text-xs transition-colors ${tab === t ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* ── Manual ── */}
            {tab === "manual" && (
              <form onSubmit={submitManual} className="space-y-4 mt-2">
                <BookFormFields form={form} setForm={setForm} />
                <Button type="submit" disabled={saving} className="w-full">
                  {saving ? "保存中..." : "登録する"}
                </Button>
              </form>
            )}

            {/* ── URL ── */}
            {tab === "url" && (
              <div className="space-y-4 mt-2">
                <div className="space-y-1">
                  <Label>書籍ページのURL</Label>
                  <div className="flex gap-2">
                    <Input
                      value={url}
                      onChange={(e) => { setUrl(e.target.value); setFetched(false); }}
                      placeholder="https://www.amazon.co.jp/dp/..."
                    />
                    <Button type="button" variant="outline" onClick={fetchUrl} disabled={fetching || !url}>
                      <LinkIcon className="w-4 h-4" />
                      {fetching ? "取得中..." : "取得"}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">Amazon・楽天ブックス・Google Booksなどに対応</p>
                </div>
                {fetched && (
                  <form onSubmit={submitUrl} className="space-y-4">
                    <BookFormFields form={form} setForm={setForm} />
                    <Button type="submit" disabled={saving} className="w-full">
                      {saving ? "保存中..." : "登録する"}
                    </Button>
                  </form>
                )}
              </div>
            )}

            {/* ── CSV ── */}
            {tab === "csv" && (
              <div className="space-y-4 mt-2">
                <div className="space-y-1">
                  <Label>CSVファイルを選択</Label>
                  <p className="text-xs text-muted-foreground">
                    列順: <code className="bg-muted px-1 rounded">title, author, readStatus, notes</code><br />
                    readStatus は read / reading / want
                  </p>
                  <Button variant="outline" className="w-full" onClick={() => fileRef.current?.click()}>
                    <Upload className="w-4 h-4 mr-2" />
                    ファイルを選ぶ
                  </Button>
                  <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleCsvFile} />
                </div>
                {csvRows.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium">{csvRows.length}冊を検出しました</p>
                    <div className="max-h-48 overflow-y-auto border rounded-md divide-y text-xs">
                      {csvRows.map((r, i) => (
                        <div key={i} className="px-3 py-1.5">
                          <span className="font-medium">{r.title}</span>
                          <span className="text-muted-foreground ml-2">{r.author}</span>
                        </div>
                      ))}
                    </div>
                    <Button className="w-full" onClick={submitCsv} disabled={csvImporting}>
                      {csvImporting ? "インポート中..." : `${csvRows.length}冊を一括登録`}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {books.length === 0 && (
        <p className="text-muted-foreground text-sm">本がまだ登録されていません。</p>
      )}

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {books.map((book) => (
          <Card
            key={book.id}
            className={`hover:shadow-md transition-shadow cursor-pointer ${selectedIds.has(book.id) ? "ring-2 ring-primary" : ""}`}
            onClick={() => book.analyzeStatus !== "analyzing" && toggleSelect(book.id)}
          >
            <CardContent className="pt-4 pb-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  {book.analyzeStatus !== "analyzing" && (
                    <button
                      className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary"
                      onClick={(e) => { e.stopPropagation(); toggleSelect(book.id); }}
                    >
                      {selectedIds.has(book.id)
                        ? <CheckSquare className="w-4 h-4 text-primary" />
                        : <Square className="w-4 h-4" />}
                    </button>
                  )}
                  <div className="min-w-0">
                    <Link
                      href={`/books/${book.id}`}
                      className="font-medium text-sm hover:underline block truncate"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {book.title}
                    </Link>
                    <p className="text-xs text-muted-foreground truncate">{book.author}</p>
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Badge variant={STATUS_MAP[book.readStatus].color} className="text-xs">
                    {STATUS_MAP[book.readStatus].label}
                  </Badge>
                </div>
              </div>

              {book.notes && (
                <p className="text-xs text-muted-foreground line-clamp-2">{book.notes}</p>
              )}

              <AnalysisRunSummary run={book.latestExtractionRun ?? null} />

              <div className="flex items-center justify-between pt-1">
                <Badge variant={ANALYZE_MAP[book.analyzeStatus].color} className="text-xs">
                  {ANALYZE_MAP[book.analyzeStatus].label}
                </Badge>
                <div className="flex gap-1">
                  {book.analyzeStatus !== "analyzing" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title={book.analyzeStatus === "done" ? "再解析" : "解析"}
                      onClick={(e) => {
                        e.stopPropagation();
                        analyze(book);
                      }}
                    >
                      <Play className="w-3 h-3" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(book);
                    }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function AnalysisRunSummary({ run }: { run: ExtractionRun | null }) {
  if (!run) {
    return <p className="text-xs text-muted-foreground">解析履歴なし</p>;
  }

  const analyzedAt = run.completedAt ?? run.createdAt;
  return (
    <div className="rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate">解析モデル: {run.model}</span>
        <span className="shrink-0">{EXTRACTION_RUN_STATUS_LABELS[run.status]}</span>
      </div>
      <p className="mt-0.5">実施日時: {formatAnalysisDate(analyzedAt)}</p>
      {run.status === "failed" && (
        <p className="mt-0.5 text-destructive">
          {analysisErrorTitle(run.error)}: {analysisErrorMessage(run.error)}
        </p>
      )}
    </div>
  );
}

function formatAnalysisDate(value: string | null) {
  if (!value) return "不明";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

// ── Shared form fields ─────────────────────────────────────────────
function BookFormFields({
  form,
  setForm,
}: {
  form: { title: string; author: string; readStatus: string; notes: string };
  setForm: React.Dispatch<React.SetStateAction<typeof form>>;
}) {
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor="title">タイトル *</Label>
        <Input
          id="title"
          value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          required
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="author">著者 *</Label>
        <Input
          id="author"
          value={form.author}
          onChange={(e) => setForm((f) => ({ ...f, author: e.target.value }))}
          required
        />
      </div>
      <div className="space-y-1">
        <Label>読書ステータス</Label>
        <Select
          value={form.readStatus}
          onValueChange={(v) => setForm((f) => ({ ...f, readStatus: v ?? "read" }))}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="read">読了</SelectItem>
            <SelectItem value="reading">読書中</SelectItem>
            <SelectItem value="want">積読</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="notes">メモ・要約（LLM解析の入力になります）</Label>
        <Textarea
          id="notes"
          rows={4}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          placeholder="読んだ感想、重要な概念、章立てなど自由に..."
        />
      </div>
    </>
  );
}

// ── CSV line parser (handles quoted fields) ───────────────────────
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}
