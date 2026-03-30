import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getOrCreateIdentitySession } from "@/lib/identity-session";
import { createConversationInRepo, readRepoMetadata } from "@/lib/repo-storage";
import {
  createLocalConversation,
  listLocalConversations,
} from "@/lib/local-fallback-store";

const assertRepoAccess = async (repoId: string) => {
  const { identity } = await getOrCreateIdentitySession();
  const { repositories } = await identity.permissions.git.list({ limit: 200 });
  return repositories.some((repo) => repo.id === repoId);
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ repoId: string }> },
) {
  const { repoId } = await params;

  if (repoId.startsWith("local-")) {
    const conversations = await listLocalConversations(repoId);
    return NextResponse.json({ conversations, isLocalFallback: true });
  }

  if (!(await assertRepoAccess(repoId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const metadata = await readRepoMetadata(repoId);
  if (!metadata) {
    return NextResponse.json({ conversations: [], isLocalFallback: true });
  }

  return NextResponse.json({ conversations: metadata.conversations });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ repoId: string }> },
) {
  const { repoId } = await params;

  let requestedTitle: string | undefined;
  try {
    const payload = (await req.json()) as { title?: string };
    const nextTitle = payload?.title?.trim();
    requestedTitle = nextTitle ? nextTitle : undefined;
  } catch {
    requestedTitle = undefined;
  }

  if (repoId.startsWith("local-")) {
    const local = await createLocalConversation(repoId, requestedTitle);
    return NextResponse.json({
      ...local,
      isLocalFallback: true,
    });
  }

  if (!(await assertRepoAccess(repoId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const metadata = await readRepoMetadata(repoId);
  if (!metadata) {
    const local = await createLocalConversation(repoId, requestedTitle);
    return NextResponse.json({
      ...local,
      isLocalFallback: true,
    });
  }

  const conversationId = randomUUID();
  const next = await createConversationInRepo(
    repoId,
    metadata,
    conversationId,
    requestedTitle,
  );

  return NextResponse.json({
    conversationId,
    conversations: next.conversations,
  });
}
