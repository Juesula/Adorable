import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  type UIMessage,
  type ToolSet,
  convertToModelMessages,
} from "ai";

type StreamLlmResponseParams = {
  system: string;
  messages: UIMessage[];
  tools: ToolSet;
};

type StreamLlmResponseResult = {
  text: string;
};

const CLOUDFLARE_MODEL =
  process.env.CLOUDFLARE_WORKERS_AI_MODEL ??
  "@cf/meta/llama-4-scout-17b-16e-instruct";

const createCloudflareProvider = () => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiKey = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiKey) {
    throw new Error(
      "Missing Cloudflare Workers AI credentials. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
    );
  }

  return createOpenAI({
    apiKey,
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
  });
};

export const streamLlmResponse = async ({
  system,
  messages,
  tools,
}: StreamLlmResponseParams): Promise<StreamLlmResponseResult> => {
  const provider = createCloudflareProvider();
  const modelMessages = await convertToModelMessages(messages);

  const result = await generateText({
    system,
    model: provider.chat(CLOUDFLARE_MODEL),
    messages: modelMessages,
    tools,
  });

  return { text: result.text };
};
