import { type UIMessage } from "ai";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import os from "os";
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

const STORE_FILE_NAME = ".local-fallback-store.json";
const storePathCandidates = [
  path.join(process.cwd(), STORE_FILE_NAME),
  path.join(os.tmpdir(), STORE_FILE_NAME),
  path.join(os.homedir(), ".adorable", STORE_FILE_NAME),
];

let resolvedWritableStorePath: string | null = null;

const isWriteError = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  const withCode = error as Error & { code?: string };
  return withCode.code === "EROFS" || withCode.code === "EACCES";
};

const ensureParentDirectory = async (filePath: string) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
};

const readStore = async (storePath: string): Promise<LocalStore | null> => {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as LocalStore;
    return {
      conversations: parsed.conversations ?? {},
      messages: parsed.messages ?? {},
    };
  } catch {
    return null;
  }
};

const loadStore = async (): Promise<LocalStore> => {
  for (const candidate of storePathCandidates) {
    const parsed = await readStore(candidate);
    if (parsed) {
      resolvedWritableStorePath ??= candidate;
      return parsed;
    }
  }

  return { conversations: {}, messages: {} };
};

const resolveWritableStorePath = async () => {
  if (resolvedWritableStorePath) return resolvedWritableStorePath;

  for (const candidate of storePathCandidates) {
    try {
      await ensureParentDirectory(candidate);
      await fs.access(path.dirname(candidate), fs.constants.W_OK);
      resolvedWritableStorePath = candidate;
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error("No writable location found for local fallback store.");
};

const saveStore = async (store: LocalStore) => {
  const raw = JSON.stringify(store, null, 2);

  const firstPath = await resolveWritableStorePath();
  try {
    await fs.writeFile(firstPath, raw, "utf8");
    return;
  } catch (error) {
    if (!isWriteError(error)) throw error;

    for (const candidate of storePathCandidates) {
      if (candidate === firstPath) continue;
      try {
        await ensureParentDirectory(candidate);
        await fs.writeFile(candidate, raw, "utf8");
        resolvedWritableStorePath = candidate;
        return;
      } catch (candidateError) {
        if (!isWriteError(candidateError)) throw candidateError;
      }
    }

    throw error;
  }
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
