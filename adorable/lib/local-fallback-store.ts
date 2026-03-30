import { type UIMessage } from "ai";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";

type ConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

type LocalStore = {
  conversations: Record<string, ConversationSummary[]>;
  messages: Record<string, UIMessage[]>;
};

const STORE_PATH = path.join(process.cwd(), ".local-fallback-store.json");

const loadStore = async (): Promise<LocalStore> => {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as LocalStore;
    return {
      conversations: parsed.conversations ?? {},
      messages: parsed.messages ?? {},
    };
  } catch {
    return { conversations: {}, messages: {} };
  }
};

const saveStore = async (store: LocalStore) => {
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
};

const convoKey = (repoId: string, conversationId: string) =>
  `${repoId}:${conversationId}`;

export const listLocalConversations = async (repoId: string) => {
  const store = await loadStore();
  return store.conversations[repoId] ?? [];
};

export const createLocalConversation = async (
  repoId: string,
  requestedTitle?: string,
) => {
  const store = await loadStore();
  const now = new Date().toISOString();
  const id = randomUUID();
  const list = store.conversations[repoId] ?? [];

  const summary: ConversationSummary = {
    id,
    title: requestedTitle ?? `Local conversation ${list.length + 1}`,
    createdAt: now,
    updatedAt: now,
  };

  store.conversations[repoId] = [summary, ...list];
  store.messages[convoKey(repoId, id)] = [];
  await saveStore(store);

  return { conversationId: id, conversations: store.conversations[repoId] };
};

export const saveLocalMessages = async (
  repoId: string,
  conversationId: string,
  messages: UIMessage[],
) => {
  const store = await loadStore();
  const key = convoKey(repoId, conversationId);
  store.messages[key] = messages;

  const convos = store.conversations[repoId] ?? [];
  const idx = convos.findIndex((c) => c.id === conversationId);
  if (idx >= 0) {
    convos[idx] = { ...convos[idx], updatedAt: new Date().toISOString() };
  }
  store.conversations[repoId] = convos;

  await saveStore(store);
};
