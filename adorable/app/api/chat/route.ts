import { type UIMessage } from "ai";
import { freestyle } from "freestyle-sandboxes";
import { createTools as createVmTools } from "@/lib/create-tools";
import { createLlmStream } from "@/lib/llm-provider";
import { adorableVmSpec } from "@/lib/adorable-vm";
import { getOrCreateIdentitySession } from "@/lib/identity-session";
import { readRepoMetadata, saveConversationMessages } from "@/lib/repo-storage";
import { saveLocalMessages } from "@/lib/local-fallback-store";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

const latestUserText = (messages: UIMessage[]): string => {
  const latest = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!latest || !Array.isArray(latest.parts)) return "";

  return latest.parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join(" ")
    .toLowerCase();
};

const isWebsiteRequest = (messages: UIMessage[]): boolean => {
  const WEBSITE_INTENT_KEYWORDS = [
    "web",
    "website",
    "pagina",
    "página",
    "landing",
    "app",
    "sitio",
    "frontend",
    "ui",
    "tailwind",
    "crear",
    "crea",
    "build",
    "haz",
  ];
  const text = latestUserText(messages);
  return WEBSITE_INTENT_KEYWORDS.some((keyword) => text.includes(keyword));
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const buildFallbackPage = (userRequest: string): string => {
  const title = userRequest.trim() || "Nueva web";
  const safeTitle = escapeHtml(title);

  return `export default function Page() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#0b1020", color: "#f8fafc", padding: 24 }}>
      <section style={{ maxWidth: 800, width: "100%", border: "1px solid #334155", borderRadius: 16, padding: 24, background: "#111827" }}>
        <h1 style={{ fontSize: 36, fontWeight: 800, marginBottom: 12 }}>${safeTitle}</h1>
        <p style={{ color: "#cbd5e1", lineHeight: 1.6 }}>
          Esta página se creó automáticamente porque el modelo no aplicó cambios de archivos en el primer intento.
        </p>
      </section>
    </main>
  );
}
`;
};

export async function POST(req: Request) {
  const payload = (await req.json()) as {
    messages?: UIMessage[];
    repoId?: string;
    conversationId?: string;
  };

  const { repoId, conversationId } = payload;
  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : undefined;

  if (!repoId || !conversationId) {
    return Response.json(
      { error: "repoId and conversationId are required." },
      { status: 400 },
    );
  }

  if (!messages) {
    return Response.json(
      { error: "messages must be an array." },
      { status: 400 },
    );
  }

  const hasCloudflareCredentials =
    !!process.env.CLOUDFLARE_ACCOUNT_ID && !!process.env.CLOUDFLARE_API_TOKEN;

  if (!hasCloudflareCredentials) {
    // Return a plain text stream response indicating missing config
    const { createUIMessageStream, createUIMessageStreamResponse } =
      await import("ai");
    const textId = crypto.randomUUID();
    const stream = createUIMessageStream({
      originalMessages: messages,
      execute: ({ writer }) => {
        const msg =
          "No hay credenciales de Cloudflare Workers AI configuradas. Configura CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_API_TOKEN.";
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: msg });
        writer.write({ type: "text-end", id: textId });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  const isLocalConversation = repoId.startsWith("local-");

  if (isLocalConversation) {
    try {
      const result = await createLlmStream({
        system: SYSTEM_PROMPT,
        messages,
        tools: {},
      });

      return result.toUIMessageStreamResponse({
        originalMessages: messages,
        onFinish: async ({ messages: finishedMessages }) => {
          await saveLocalMessages(repoId, conversationId, finishedMessages);
        },
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Unknown local LLM error.";
      const { createUIMessageStream, createUIMessageStreamResponse } =
        await import("ai");
      const textId = crypto.randomUUID();
      const stream = createUIMessageStream({
        originalMessages: messages,
        execute: ({ writer }) => {
          writer.write({ type: "text-start", id: textId });
          writer.write({
            type: "text-delta",
            id: textId,
            delta: `No pude generar respuesta en modo local: ${detail}`,
          });
          writer.write({ type: "text-end", id: textId });
        },
      });
      return createUIMessageStreamResponse({ stream });
    }
  }

  const { identity } = await getOrCreateIdentitySession();
  const { repositories } = await identity.permissions.git.list({ limit: 200 });
  const hasAccess = repositories.some((repo) => repo.id === repoId);

  if (!hasAccess) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const metadata = await readRepoMetadata(repoId);
  if (!metadata) {
    return Response.json(
      { error: "Repository metadata not found." },
      { status: 404 },
    );
  }

  // Save messages before starting the stream
  await saveConversationMessages(repoId, metadata, conversationId, messages);

  const vm = freestyle.vms.ref({
    vmId: metadata.vm.vmId,
    spec: adorableVmSpec,
  });

  try {
    const editedFiles = new Set<string>();

    const tools = createVmTools(vm, {
      sourceRepoId: metadata.sourceRepoId,
      metadataRepoId: repoId,
      onFileEdit: (file) => {
        editedFiles.add(file);
      },
    });

    const result = await createLlmStream({
      system: SYSTEM_PROMPT,
      messages,
      tools,
    });

    return result.toUIMessageStreamResponse({
      originalMessages: messages,
      onFinish: async ({ messages: finishedMessages }) => {
        // Apply fallback if no files were edited for a website request
        if (editedFiles.size === 0 && isWebsiteRequest(messages)) {
          const requestText = latestUserText(messages);
          await vm.fs.writeTextFile(
            "app/page.tsx",
            buildFallbackPage(requestText),
          );
        }

        const latestMetadata = await readRepoMetadata(repoId);
        if (latestMetadata) {
          await saveConversationMessages(
            repoId,
            latestMetadata,
            conversationId,
            finishedMessages,
          );
        }
      },
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Unknown backend LLM error.";
    const { createUIMessageStream, createUIMessageStreamResponse } =
      await import("ai");
    const textId = crypto.randomUUID();
    const stream = createUIMessageStream({
      originalMessages: messages,
      execute: ({ writer }) => {
        writer.write({ type: "text-start", id: textId });
        writer.write({
          type: "text-delta",
          id: textId,
          delta: `No pude generar respuesta del asistente: ${detail}`,
        });
        writer.write({ type: "text-end", id: textId });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }
}
