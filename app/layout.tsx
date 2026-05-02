import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import Navigation from "@/components/layout/Navigation";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "読書知識マップ",
  description: "読んだ本の概念をグラフで可視化するローカルアプリ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="h-full flex flex-col bg-background text-foreground antialiased">
        <Navigation />
        <main className="flex-1 overflow-hidden">{children}</main>
        <Toaster richColors position="bottom-right" />
      </body>
    </html>
  );
}
