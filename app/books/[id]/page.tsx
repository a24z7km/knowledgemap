"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Play, Trash2, Brain } from "lucide-react";
import type { Book } from "@/lib/db/schema";

interface ConceptRow {
  id: number;
  conceptId: number;
  conceptName: string;
  conceptDomain: string;
  conceptDescription: string | null;
  importance: number;
  excerpt: string | null;
}

const DOMAIN_COLOR: Record<string, string> = {
  cybersec: "bg-red-100 text-red-800",
  finance: "bg-green-100 text-green-800",
  law: "bg-blue-100 text-blue-800",
  cs: "bg-purple-100 text-purple-800",
  math: "bg-yellow-100 text-yellow-800",
  general: "bg-gray-100 text-gray-800",
};

export default function BookDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [book, setBook] = useState<Book | null>(null);
  const [concepts, setConcepts] = useState<ConceptRow[]>([]);

  const load = () =>
    fetch(`/api/books/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.book) {
          setBook(data.book);
          setConcepts(data.concepts ?? []);
        }
      });

  useEffect(() => {
    load();
    const iv = setInterval(() => {
      load();
    }, 3000);
    return () => clearInterval(iv);
  }, [id]);

  const analyze = async () => {
    const res = await fetch(`/api/analyze/${id}`, { method: "POST" });
    if (res.ok) {
      toast.info("解析を開始しました...");
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
          {(book.analyzeStatus === "pending" || book.analyzeStatus === "error") && (
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
            <div className="flex items-center gap-2 text-blue-700 text-sm mb-2">
              <Brain className="w-4 h-4 animate-pulse" />
              LLMが概念と関係を抽出中です...
            </div>
            <Progress value={null} className="h-1.5" />
          </CardContent>
        </Card>
      )}

      {book.analyzeStatus === "error" && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-3 text-sm text-red-700">
            解析エラー: {book.analyzeError}
          </CardContent>
        </Card>
      )}

      {book.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">メモ・要約</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{book.notes}</p>
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
          <CardContent>
            <div className="space-y-3">
              {concepts
                .sort((a, b) => b.importance - a.importance)
                .map((c) => (
                  <div key={c.id}>
                    <div className="flex items-start gap-2">
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                          DOMAIN_COLOR[c.conceptDomain] ?? DOMAIN_COLOR.general
                        }`}
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
