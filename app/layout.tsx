import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "zhiwen.internal";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const metadataBase = new URL(`${protocol}://${host}`);

  return {
    metadataBase,
    title: "知问 · 内部 AI 知识助手",
    description: "面向团队的可追溯内部知识问答工具。",
    openGraph: {
      title: "知问 · 内部 AI 知识助手",
      description: "公司知识，一问即得；每个回答都附有可核对的来源。",
      images: [{ url: new URL("/og.png", metadataBase).toString(), width: 1200, height: 628 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "知问 · 内部 AI 知识助手",
      description: "公司知识，一问即得；每个回答都附有可核对的来源。",
      images: [new URL("/og.png", metadataBase).toString()],
    },
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
