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
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

const createTextResponse = (text: string) => {
  const textId = crypto.randomUUID();
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "text-start", id: textId });
      writer.write({ type: "text-delta", id: textId, delta: text });
      writer.write({ type: "text-end", id: textId });
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
    return Response.json(
      {
        error:
          "Missing Cloudflare Workers AI credentials. Configure CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN on the backend.",
      },
      { status: 500 },
    );
  }

  const isLocalConversation = repoId.startsWith("local-");

  if (isLocalConversation) {
    const llm = await streamLlmResponse({
      system: SYSTEM_PROMPT,
      messages,
      tools: {},
    });

    return createTextResponse(llm.text);
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

  const tools = createVmTools(vm, {
    sourceRepoId: metadata.sourceRepoId,
    metadataRepoId: repoId,
  });

  const llm = await streamLlmResponse({
    system: SYSTEM_PROMPT,
    messages,
    tools,
  });

  const finalMessages = appendAssistantMessage(messages, llm.text);
  const latestMetadata = await readRepoMetadata(repoId);
  if (latestMetadata) {
    await saveConversationMessages(
      repoId,
      latestMetadata,
      conversationId,
      finalMessages,
    );
  }

  return createTextResponse(llm.text);
}
