"use client";

import { useEffect, useState } from "react";
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
import { Plus, Trash2, Play } from "lucide-react";
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

export default function BooksPage() {
  const [books, setBooks] = useState<Book[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", author: "", readStatus: "read", notes: "" });
  const [saving, setSaving] = useState(false);

  const load = () =>
    fetch("/api/books")
      .then((r) => r.json())
      .then(setBooks);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, []);

  const submit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
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
      setForm({ title: "", author: "", readStatus: "read", notes: "" });
      load();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  };

  const analyze = async (book: Book) => {
    const res = await fetch(`/api/analyze/${book.id}`, { method: "POST" });
    if (res.ok) {
      toast.info(`「${book.title}」の解析を開始しました`);
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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">本一覧</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button size="sm" />}>
            <Plus className="w-4 h-4 mr-1" /> 本を追加
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>本を登録</DialogTitle>
            </DialogHeader>
            <form onSubmit={submit} className="space-y-4 mt-2">
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
                  rows={5}
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="読んだ感想、重要な概念、章立てなど自由に..."
                />
              </div>
              <Button type="submit" disabled={saving} className="w-full">
                {saving ? "保存中..." : "登録する"}
              </Button>
            </form>
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
                  {(book.analyzeStatus === "pending" || book.analyzeStatus === "error") && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => analyze(book)}>
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
