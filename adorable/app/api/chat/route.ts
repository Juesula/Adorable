import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { freestyle } from "freestyle-sandboxes";
import { createTools as createVmTools } from "@/lib/create-tools";
import { streamLlmResponse } from "@/lib/llm-provider";
import { adorableVmSpec } from "@/lib/adorable-vm";
import { getOrCreateIdentitySession } from "@/lib/identity-session";
import { readRepoMetadata, saveConversationMessages } from "@/lib/repo-storage";
import { saveLocalMessages } from "@/lib/local-fallback-store";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

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

const latestUserText = (messages: UIMessage[]): string => {
  const latest = [...messages].reverse().find((message) => message.role === "user");
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

const createTextResponse = (text: string, originalMessages: UIMessage[]) => {
  const textId = crypto.randomUUID();
  const stream = createUIMessageStream({
    originalMessages,
    execute: ({ writer }) => {
      writer.write({ type: "text-start", id: textId });
      writer.write({ type: "text-delta", id: textId, delta: text });
      writer.write({ type: "text-end", id: textId });
    },
  });

  return createUIMessageStreamResponse({ stream });
};

const createStreamingLlmResponse = ({
  originalMessages,
  run,
}: {
  originalMessages: UIMessage[];
  run: (callbacks: {
    onTextDelta: (delta: string) => void;
    onFileEdit: (file: string) => void;
  }) => Promise<string>;
}) => {
  const textId = crypto.randomUUID();

  const stream = createUIMessageStream({
    originalMessages,
    execute: async ({ writer }) => {
      writer.write({ type: "text-start", id: textId });

      const onTextDelta = (delta: string) => {
        writer.write({ type: "text-delta", id: textId, delta });
      };

      const onFileEdit = (file: string) => {
        writer.write({
          type: "text-delta",
          id: textId,
          delta: `\n\nediting (${file})`,
        });
      };

      try {
        await run({ onTextDelta, onFileEdit });
      } finally {
        writer.write({ type: "text-end", id: textId });
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
};

const appendAssistantMessage = (
  messages: UIMessage[],
  text: string,
): UIMessage[] => {
  const assistantMessage: UIMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [{ type: "text", text }],
  };

  return [...messages, assistantMessage];
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
    return createTextResponse(
      "No hay credenciales de Cloudflare Workers AI configuradas en backend. Configura CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_API_TOKEN para respuestas reales.",
      messages,
    );
  }

  const isLocalConversation = repoId.startsWith("local-");

  if (isLocalConversation) {
    try {
      return createStreamingLlmResponse({
        originalMessages: messages,
        run: async ({ onTextDelta }) => {
          const llm = await streamLlmResponse({
            system: SYSTEM_PROMPT,
            messages,
            tools: {},
            onTextDelta,
          });

          const finalMessages = appendAssistantMessage(messages, llm.text);
          await saveLocalMessages(repoId, conversationId, finalMessages);
          return llm.text;
        },
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Unknown local LLM error.";
      return createTextResponse(
        `No pude generar respuesta en modo local: ${detail}`,
        messages,
      );
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

  await saveConversationMessages(repoId, metadata, conversationId, messages);

  const vm = freestyle.vms.ref({
    vmId: metadata.vm.vmId,
    spec: adorableVmSpec,
  });

  try {
    return createStreamingLlmResponse({
      originalMessages: messages,
      run: async ({ onTextDelta, onFileEdit }) => {
        const editedFiles = new Set<string>();
        const websiteRequest = isWebsiteRequest(messages);
        const maxLlmRequests = websiteRequest ? 3 : 1;
        const toolsWithEditEvents = createVmTools(vm, {
          sourceRepoId: metadata.sourceRepoId,
          metadataRepoId: repoId,
          onFileEdit: (file) => {
            editedFiles.add(file);
            onFileEdit(file);
          },
        });

        let finalText = "";

        for (let attempt = 1; attempt <= maxLlmRequests; attempt += 1) {
          const attemptSystem =
            attempt === 1
              ? SYSTEM_PROMPT
              : `${SYSTEM_PROMPT}\n\nAttempt ${attempt}/${maxLlmRequests}: You must apply concrete file edits using tools before you answer.`;

          if (attempt > 1) {
            onTextDelta(
              `\n\nNo hubo cambios de archivos en el intento anterior. Reintentando (${attempt}/${maxLlmRequests})...\n`,
            );
          }

          const llm = await streamLlmResponse({
            system: attemptSystem,
            messages,
            tools: toolsWithEditEvents,
            onTextDelta,
          });

          finalText = finalText ? `${finalText}\n\n${llm.text}` : llm.text;

          if (editedFiles.size > 0) {
            break;
          }
        }

        if (editedFiles.size === 0 && isWebsiteRequest(messages)) {
          const requestText = latestUserText(messages);
          await vm.fs.writeTextFile("app/page.tsx", buildFallbackPage(requestText));
          onFileEdit("app/page.tsx");
          const note =
            "\n\nHe aplicado un fallback automático en app/page.tsx para que la web aparezca en preview.";
          onTextDelta(note);
          finalText += note;
        }

        const finalMessages = appendAssistantMessage(messages, finalText);
        const latestMetadata = await readRepoMetadata(repoId);
        if (latestMetadata) {
          await saveConversationMessages(
            repoId,
            latestMetadata,
            conversationId,
            finalMessages,
          );
        }

        return finalText;
      },
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Unknown backend LLM error.";
    return createTextResponse(
      `No pude generar respuesta del asistente: ${detail}`,
      messages,
    );
  }
}
