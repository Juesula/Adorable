import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { freestyle } from "freestyle-sandboxes";
import { TEMPLATE_REPO } from "@/lib/vars";
import { createVmForRepo } from "@/lib/adorable-vm";
import { getOrCreateIdentitySession } from "@/lib/identity-session";
import {
  ADORABLE_WRAPPER_REPO_PREFIX,
  type RepoMetadata,
  type RepoDeploymentSummary,
  createConversationInRepo,
  readRepoMetadata,
  writeRepoMetadata,
} from "@/lib/repo-storage";

const toDisplayRepoName = (name?: string | null) => {
  if (!name) return undefined;
  return name.startsWith(ADORABLE_WRAPPER_REPO_PREFIX)
    ? name.slice(ADORABLE_WRAPPER_REPO_PREFIX.length)
    : name;
};

type DeploymentEntry = {
  deploymentId: string;
  state: "building" | "deployed" | "failed";
  domains: string[];
};

const reconcileDeploymentState = (
  deployment: RepoDeploymentSummary,
  entries: DeploymentEntry[],
): RepoDeploymentSummary => {
  const matchById = deployment.deploymentId
    ? entries.find((entry) => entry.deploymentId === deployment.deploymentId)
    : undefined;

  const matchByDomain = entries.find((entry) =>
    entry.domains.includes(deployment.domain),
  );

  const match = matchById ?? matchByDomain;
  if (!match) {
    return {
      ...deployment,
      state: deployment.state === "deploying" ? "idle" : deployment.state,
    };
  }

  const state: RepoDeploymentSummary["state"] =
    match.state === "deployed"
      ? "live"
      : match.state === "failed"
        ? "failed"
        : "deploying";

  return {
    ...deployment,
    deploymentId: match.deploymentId ?? deployment.deploymentId,
    state,
  };
};

const toRepoResponse = async (
  repo: { id: string; name?: string | null },
  deploymentEntries: DeploymentEntry[],
) => {
  const metadata = await readRepoMetadata(repo.id);
  const repoDisplayName = toDisplayRepoName(repo.name);
  const metadataDisplayName = toDisplayRepoName(metadata?.name);
  const reconciledMetadata = metadata
    ? {
        ...metadata,
        deployments: metadata.deployments.map((deployment) =>
          reconcileDeploymentState(deployment, deploymentEntries),
        ),
      }
    : metadata;

  return {
    id: repo.id,
    name: repoDisplayName ?? metadataDisplayName ?? "Untitled Repo",
    metadata: reconciledMetadata,
  };
};

export async function GET() {
  try {
    const { identityId, identity } = await getOrCreateIdentitySession();
    const { repositories } = await identity.permissions.git.list({
      limit: 200,
    });
    const wrapperRepositories = repositories.filter((repo) =>
      (repo.name ?? "").startsWith(ADORABLE_WRAPPER_REPO_PREFIX),
    );

    let deploymentEntries: DeploymentEntry[] = [];
    try {
      const { entries } = await freestyle.serverless.deployments.list({
        limit: 500,
      });
      deploymentEntries = entries as DeploymentEntry[];
    } catch {
      deploymentEntries = [];
    }

    const items = await Promise.all(
      wrapperRepositories.map((repo) =>
        toRepoResponse(repo, deploymentEntries),
      ),
    );

    return NextResponse.json({
      identityId,
      repositories: items,
    });
  } catch (error) {
    console.error("Failed to load repositories", error);

    return NextResponse.json({
      identityId: null,
      repositories: [],
    });
  }
}

export async function POST(req: Request) {
  try {
    const { identity } = await getOrCreateIdentitySession();

    let requestedName: string | undefined;
    let requestedConversationTitle: string | undefined;
    let githubRepoName: string | undefined;
    try {
      const payload = (await req.json()) as {
        name?: string;
        conversationTitle?: string;
        githubRepoName?: string;
      };
      const nextName = payload?.name?.trim();
      const nextConversationTitle = payload?.conversationTitle?.trim();
      const nextGithubRepoName = payload?.githubRepoName?.trim();
      requestedName = nextName ? nextName : undefined;
      requestedConversationTitle = nextConversationTitle
        ? nextConversationTitle
        : undefined;
      githubRepoName = nextGithubRepoName ? nextGithubRepoName : undefined;
    } catch {
      requestedName = undefined;
      requestedConversationTitle = undefined;
      githubRepoName = undefined;
    }

    // Create repo with GitHub Sync or from template
    let sourceRepoId: string;
    if (githubRepoName) {
      const { repo, repoId: createdRepoId } = await freestyle.git.repos.create(
        requestedName ? { name: requestedName } : {},
      );
      sourceRepoId = createdRepoId;

      // Enable GitHub Sync
      await repo.githubSync.enable({ githubRepoName });
    } else {
      // Create from template
      const created = await freestyle.git.repos.create({
        ...(requestedName ? { name: requestedName } : {}),
        import: {
          commitMessage: "Initial commit",
          url: TEMPLATE_REPO,
          type: "git",
        },
      });
      sourceRepoId = created.repoId;
    }

    const inferredName =
      requestedName ?? githubRepoName?.split("/").pop()?.trim() ?? "Project";
    const wrapperRepoName = `${ADORABLE_WRAPPER_REPO_PREFIX}${inferredName}`;
    const wrapperCreated = await freestyle.git.repos.create({
      name: wrapperRepoName,
    });
    const wrapperRepoId = wrapperCreated.repoId;

    await identity.permissions.git.grant({
      permission: "write",
      repoId: sourceRepoId,
    });

    await identity.permissions.git.grant({
      permission: "write",
      repoId: wrapperRepoId,
    });

    const vm = await createVmForRepo(sourceRepoId);

    await identity.permissions.vms.grant({
      vmId: vm.vmId,
    });

    const initialMetadata: RepoMetadata = {
      version: 2,
      sourceRepoId,
      ...(requestedName ? { name: requestedName } : {}),
      vm,
      conversations: [],
      deployments: [],
      productionDomain: null,
      productionDeploymentId: null,
    };

    await writeRepoMetadata(wrapperRepoId, initialMetadata);

    const conversationId = randomUUID();
    const metadata = await createConversationInRepo(
      wrapperRepoId,
      initialMetadata,
      conversationId,
      requestedConversationTitle,
    );

    return NextResponse.json({
      id: wrapperRepoId,
      metadata,
      conversationId,
    });
  } catch (error) {
    console.error("Failed to create repository", error);

    return NextResponse.json({
      error:
        "Failed to create repository. Verify Freestyle backend credentials and try again.",
    });
  }
}
