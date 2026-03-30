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
  model: string;
  profile: ModelProfile;
};

const DEFAULT_MODEL =
  process.env.CLOUDFLARE_WORKERS_AI_MODEL ??
  "@cf/meta/llama-4-scout-17b-16e-instruct";

const VISUAL_MODEL =
  process.env.CLOUDFLARE_WORKERS_AI_MODEL_VISUAL ?? DEFAULT_MODEL;

const FUNCTION_MODEL =
  process.env.CLOUDFLARE_WORKERS_AI_MODEL_FUNCTIONS ?? DEFAULT_MODEL;

const GENERAL_MODEL =
  process.env.CLOUDFLARE_WORKERS_AI_MODEL_GENERAL ?? DEFAULT_MODEL;

type ModelProfile = "visual" | "functions" | "general";

const VISUAL_KEYWORDS = [
  "ui",
  "ux",
  "visual",
  "diseño",
  "diseno",
  "animación",
  "animacion",
  "animation",
  "tailwind",
  "css",
  "layout",
  "responsive",
  "color",
  "estilo",
  "frontend",
  "front-end",
  "interfaz",
];

const FUNCTION_KEYWORDS = [
  "función",
  "funcion",
  "function",
  "api",
  "endpoint",
  "backend",
  "logic",
  "lógica",
  "logica",
  "database",
  "db",
  "auth",
  "validation",
  "validación",
  "validacion",
  "state",
  "server action",
  "integration",
  "webhook",
];

const getMessageText = (message: UIMessage): string => {
  if (!Array.isArray(message.parts)) return "";

  return message.parts
    .filter((part): part is { type: "text"; text: string } => {
      return (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      );
    })
    .map((part) => part.text)
    .join(" ")
    .toLowerCase();
};

const detectModelProfile = (messages: UIMessage[]): ModelProfile => {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");

  const text = latestUserMessage ? getMessageText(latestUserMessage) : "";

  if (VISUAL_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return "visual";
  }

  if (FUNCTION_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return "functions";
  }

  return "general";
};

const getModelForProfile = (profile: ModelProfile): string => {
  if (profile === "visual") return VISUAL_MODEL;
  if (profile === "functions") return FUNCTION_MODEL;
  return GENERAL_MODEL;
};

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
  const profile = detectModelProfile(messages);
  const selectedModel = getModelForProfile(profile);
  const modelMessages = await convertToModelMessages(messages);

  const result = await generateText({
    system,
    model: provider.chat(selectedModel),
    messages: modelMessages,
    tools,
  });

  return { text: result.text, model: selectedModel, profile };
};
