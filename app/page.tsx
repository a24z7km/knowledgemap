"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BookOpen, Network, Brain, Clock } from "lucide-react";
import type { Book } from "@/lib/db/schema";

export default function DashboardPage() {
  const [books, setBooks] = useState<Book[]>([]);
  const [stats, setStats] = useState({ concepts: 0, edges: 0 });

  useEffect(() => {
    fetch("/api/books").then((r) => r.json()).then(setBooks);
    fetch("/api/graph").then((r) => r.json()).then((data) => {
      if (data.nodes) setStats({ concepts: data.nodes.length, edges: data.edges.length });
    });
  }, []);

  const doneBooks = books.filter((b) => b.analyzeStatus === "done").length;
  const pendingBooks = books.filter((b) => b.analyzeStatus === "pending").length;
  const recentBooks = books.slice(0, 5);

  return (
    <div className="max-w-screen-xl mx-auto px-4 py-6 space-y-6">
      <h1 className="text-2xl font-bold">ダッシュボード</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={<BookOpen className="w-5 h-5" />} label="登録冊数" value={books.length} />
        <StatCard icon={<Brain className="w-5 h-5" />} label="抽出概念数" value={stats.concepts} />
        <StatCard icon={<Network className="w-5 h-5" />} label="関係エッジ数" value={stats.edges} />
        <StatCard icon={<Clock className="w-5 h-5" />} label="解析済み" value={doneBooks} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">最近登録した本</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {recentBooks.length === 0 && (
              <p className="text-sm text-muted-foreground">
                まだ本が登録されていません。{" "}
                <Link href="/books" className="underline">本を追加する</Link>
              </p>
            )}
            {recentBooks.map((b) => (
              <div key={b.id} className="flex items-center justify-between">
                <Link href={`/books/${b.id}`} className="text-sm hover:underline truncate max-w-[200px]">
                  {b.title}
                </Link>
                <Badge variant={
                  (b.analyzeStatus === "error" || b.analyzeStatus === "failed") ? "destructive" :
                  b.analyzeStatus === "pending" ? "secondary" : "default"
                }>
                  {b.analyzeStatus === "done" ? "解析済" :
                   b.analyzeStatus === "analyzing" ? "解析中..." :
                   (b.analyzeStatus === "error" || b.analyzeStatus === "failed") ? "エラー" : "未解析"}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">クイックアクション</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Link href="/books" className="block text-sm hover:underline">→ 本を登録する</Link>
            <Link href="/map" className="block text-sm hover:underline">→ 知識マップを見る</Link>
            {pendingBooks > 0 && (
              <p className="text-sm text-amber-600">
                {pendingBooks}冊が未解析です。本の詳細ページから解析を実行できます。
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center gap-2 text-muted-foreground mb-1">
          {icon}
          <span className="text-xs">{label}</span>
        </div>
        <p className="text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}
