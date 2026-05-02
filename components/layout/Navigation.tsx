"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Network, LayoutDashboard } from "lucide-react";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "ダッシュボード", icon: LayoutDashboard },
  { href: "/map", label: "マップ", icon: Network },
  { href: "/books", label: "本一覧", icon: BookOpen },
];

export default function Navigation() {
  const pathname = usePathname();
  return (
    <nav className="border-b bg-background/95 backdrop-blur sticky top-0 z-50">
      <div className="max-w-screen-xl mx-auto px-4 h-12 flex items-center gap-6">
        <span className="font-semibold text-sm mr-2">📚 知識マップ</span>
        {links.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={(e) => {
              if (pathname === href) {
                e.preventDefault();
                window.location.href = href;
              }
            }}
            className={cn(
              "flex items-center gap-1.5 text-sm font-medium transition-colors hover:text-foreground",
              pathname === href ? "text-foreground" : "text-muted-foreground"
            )}
          >
            <Icon className="w-4 h-4" />
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
