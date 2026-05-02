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
import { Plus, Trash2, Play, Link as LinkIcon, Upload } from "lucide-react";
import type { Book } from "@/lib/db/schema";

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
};

type Tab = "manual" | "url" | "csv";

const EMPTY_FORM = { title: "", author: "", readStatus: "read", notes: "" };

export default function BooksPage() {
  const [books, setBooks] = useState<Book[]>([]);
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
  const analyze = async (book: Book) => {
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

  const remove = async (book: Book) => {
    if (!confirm(`「${book.title}」を削除しますか?`)) return;
    await fetch(`/api/books/${book.id}`, { method: "DELETE" });
    toast.success("削除しました");
    load();
  };

  return (
    <div className="max-w-screen-xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">本一覧</h1>
        <div className="flex items-center gap-2 ml-auto">
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
              <SelectItem value="o1-mini">o1-mini　〜9円/冊</SelectItem>
              <SelectItem value="o3">o3　〜50円/冊</SelectItem>
            </SelectContent>
          </Select>
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
          <Card key={book.id} className="hover:shadow-md transition-shadow">
            <CardContent className="pt-4 pb-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/books/${book.id}`} className="font-medium text-sm hover:underline block truncate">
                    {book.title}
                  </Link>
                  <p className="text-xs text-muted-foreground truncate">{book.author}</p>
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
                      onClick={() => analyze(book)}
                    >
                      <Play className="w-3 h-3" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(book)}>
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
