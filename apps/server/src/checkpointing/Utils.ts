import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type EventId, type ThreadId } from "@t3tools/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function safeUndoRecoveryRefs(input: {
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly eventId: EventId;
}): { readonly workspace: CheckpointRef; readonly index: CheckpointRef } {
  const threadKey = Encoding.encodeBase64Url(input.threadId);
  const eventKey = Encoding.encodeBase64Url(input.eventId);
  const prefix = `${CHECKPOINT_REFS_PREFIX}/${threadKey}/recovery/turn/${input.turnCount}/${eventKey}`;
  return {
    workspace: CheckpointRef.make(`${prefix}/workspace`),
    index: CheckpointRef.make(`${prefix}/index`),
  };
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
