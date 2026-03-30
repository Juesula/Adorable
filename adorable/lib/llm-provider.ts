import { createOpenAI } from "@ai-sdk/openai";
import {
  streamText,
  stepCountIs,
  type UIMessage,
  type ToolSet,
  convertToModelMessages,
} from "ai";

type StreamLlmResponseParams = {
  system: string;
  messages: UIMessage[];
  tools: ToolSet;
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

const WEBSITE_BUILD_KEYWORDS = [
  "build",
  "crear",
  "crea",
  "haz",
  "make",
  "app",
  "web",
  "website",
  "pagina",
  "página",
  "landing",
  "dashboard",
  "component",
  "componente",
  "ui",
  "ux",
  "tailwind",
  "animacion",
  "animación",
];

const normalizeText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const hasKeyword = (text: string, keyword: string): boolean => {
  const normalizedText = normalizeText(text);
  const normalizedKeyword = normalizeText(keyword);

  if (normalizedKeyword.includes(" ")) {
    return normalizedText.includes(normalizedKeyword);
  }

  const words = new Set(normalizedText.split(/[^a-z0-9_-]+/).filter(Boolean));
  return words.has(normalizedKeyword);
};

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

  if (VISUAL_KEYWORDS.some((keyword) => hasKeyword(text, keyword))) {
    return "visual";
  }

  if (FUNCTION_KEYWORDS.some((keyword) => hasKeyword(text, keyword))) {
    return "functions";
  }

  return "general";
};

export const shouldRequireToolUse = (
  messages: UIMessage[],
  tools: ToolSet,
): boolean => {
  if (!tools || Object.keys(tools).length === 0) return false;

  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const text = latestUserMessage ? getMessageText(latestUserMessage) : "";

  return WEBSITE_BUILD_KEYWORDS.some((keyword) => hasKeyword(text, keyword));
};

const getModelForProfile = (profile: ModelProfile): string => {
  if (profile === "visual") return VISUAL_MODEL;
  if (profile === "functions") return FUNCTION_MODEL;
  return GENERAL_MODEL;
};

/**
 * Cloudflare Workers AI sometimes emits SSE chunks where `delta.content` is
 * a number (e.g. `1`) instead of a string. The AI SDK's OpenAI-compat layer
 * runs strict type validation and throws "Type validation failed" on those
 * chunks. We fix this with a custom `fetch` wrapper that rewrites every SSE
 * line on the fly, coercing `content` to a string before the SDK sees it.
 */
const sanitizeCloudflareStream = (
  response: Response,
): Response => {
  if (!response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const transformed = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const fixed = text
        .split("\n")
        .map((line) => {
          if (!line.startsWith("data:")) return line;
          const jsonPart = line.slice(5).trim();
          if (!jsonPart || jsonPart === "[DONE]") return line;
          try {
            const parsed = JSON.parse(jsonPart);
            let dirty = false;
            if (Array.isArray(parsed?.choices)) {
              for (const choice of parsed.choices) {
                const delta = choice?.delta;
                if (delta && typeof delta.content !== "string" && delta.content !== undefined) {
                  delta.content = delta.content == null ? null : String(delta.content);
                  dirty = true;
                }
              }
            }
            return dirty ? `data: ${JSON.stringify(parsed)}` : line;
          } catch {
            return line;
          }
        })
        .join("\n");
      controller.enqueue(encoder.encode(fixed));
    },
  });

  response.body.pipeTo(transformed.writable).catch(() => {});

  return new Response(transformed.readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        return sanitizeCloudflareStream(response);
      }
      return response;
    },
  });
};

export const createLlmStream = async ({
  system,
  messages,
  tools,
}: StreamLlmResponseParams) => {
  const provider = createCloudflareProvider();
  const profile = detectModelProfile(messages);
  const selectedModel = getModelForProfile(profile);
  const modelMessages = await convertToModelMessages(messages);
  const requireToolUse = shouldRequireToolUse(messages, tools);

  return streamText({
    system,
    model: provider.chat(selectedModel),
    messages: modelMessages,
    tools,
    toolChoice: "auto",
    stopWhen: stepCountIs(requireToolUse ? 20 : 6),
  });
};
