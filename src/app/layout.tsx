import type { Metadata } from "next";

import { SiteNavigation } from "@/components/site-navigation";

import "./globals.css";

export const metadata: Metadata = {
  title: "医生接诊辅助原型",
  description: "仅使用合成数据的医生病历记录、资料查阅与完成前复核原型",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="global-boundary">仅合成数据 · 临床前技术原型 · 需人工复核</div>
        <SiteNavigation />
        {children}
      </body>
    </html>
  );
}
