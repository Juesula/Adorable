import { type UIMessage } from "ai";
import { freestyle } from "freestyle-sandboxes";
import { createTools as createVmTools } from "@/lib/create-tools";
import { createLlmStream } from "@/lib/llm-provider";
import { adorableVmSpec } from "@/lib/adorable-vm";
import { getOrCreateIdentitySession } from "@/lib/identity-session";
import { readRepoMetadata, saveConversationMessages } from "@/lib/repo-storage";
import { saveLocalMessages } from "@/lib/local-fallback-store";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";
import { WORKDIR } from "@/lib/vars";
import type { Vm } from "freestyle-sandboxes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const latestUserText = (messages: UIMessage[]): string => {
  const latest = [...messages]
    .reverse()
    .find((m) => m.role === "user");
  if (!latest || !Array.isArray(latest.parts)) return "";
  return latest.parts
    .filter(
      (p): p is { type: "text"; text: string } =>
        typeof p === "object" && p !== null && (p as { type: string }).type === "text",
    )
    .map((p) => p.text)
    .join(" ")
    .toLowerCase();
};

const isWebsiteRequest = (messages: UIMessage[]): boolean => {
  const keywords = [
    "web", "website", "pagina", "página", "landing", "app",
    "sitio", "frontend", "ui", "tailwind", "crear", "crea", "build", "haz",
  ];
  const text = latestUserText(messages);
  return keywords.some((kw) => text.includes(kw));
};

const escapeHtml = (v: string) =>
  v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
   .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const buildFallbackPage = (userRequest: string): string => {
  const safe = escapeHtml(userRequest.trim() || "Nueva web");
  return `export default function Page() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#0b1020", color: "#f8fafc", padding: 24 }}>
      <section style={{ maxWidth: 800, width: "100%", border: "1px solid #334155", borderRadius: 16, padding: 24, background: "#111827" }}>
        <h1 style={{ fontSize: 36, fontWeight: 800, marginBottom: 12 }}>${safe}</h1>
        <p style={{ color: "#cbd5e1", lineHeight: 1.6 }}>Esta página fue generada automáticamente.</p>
      </section>
    </main>
  );
}
`;
};

const makeTextStream = async (messages: UIMessage[], text: string) => {
  const { createUIMessageStream, createUIMessageStreamResponse } = await import("ai");
  const id = crypto.randomUUID();
  const stream = createUIMessageStream({
    originalMessages: messages,
    execute: ({ writer }) => {
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: text });
      writer.write({ type: "text-end", id });
    },
  });
  return createUIMessageStreamResponse({ stream });
};

/**
 * Ensure the VM dev server runs with webpack, NOT Turbopack.
 * Next.js 16 enables Turbopack by default which fails in the Freestyle sandbox
 * because it cannot resolve next/package.json from the /workspace root.
 * We force --no-turbopack by rewriting the dev script and restarting.
 */
const ensureVmReady = async (vm: Vm): Promise<void> => {
  try {
    const raw = await vm.fs.readTextFile("package.json");
    const pkg = JSON.parse(typeof raw === "string" ? raw : String(raw)) as {
      scripts?: Record<string, string>;
    };

    const current = pkg?.scripts?.dev ?? "";
    // Already forced to webpack
    if (current.includes("--no-turbopack")) return;

    // Remove any existing --turbopack flag, then add --no-turbopack
    pkg.scripts!.dev = current
      .replace(/\s*--turbopack\b/g, "")
      .replace(/^(next dev)/, "$1 --no-turbopack")
      .trim();

    await vm.fs.writeTextFile("package.json", JSON.stringify(pkg, null, 2));

    // Restart dev server so the new script takes effect
    await (vm as unknown as {
      exec: (opts: { command: string }) => Promise<unknown>;
    }).exec({
      command: `cd ${WORKDIR} && pkill -f "next dev" 2>/dev/null || true && sleep 1 && nohup npm run dev > /tmp/next-dev.log 2>&1 &`,
    });
  } catch (err) {
    // Non-fatal — LLM can still run even if patching fails
    console.error("[v0] ensureVmReady error (non-fatal):", err);
  }
}
