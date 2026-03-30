import type { Metadata } from "next";
import { WorkspaceFrame } from "./workspace-frame";
import "./globals.css";

export const metadata: Metadata = {
  title: "Adorable",
  description: "Build beautiful apps with AI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark h-full overflow-hidden">
      <body className="h-full overflow-hidden overscroll-none antialiased">
        <WorkspaceFrame>{children}</WorkspaceFrame>
      </body>
    </html>
  );
}
