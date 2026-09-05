import {
  CommandId,
  type CheckpointRef,
  EventId,
  MessageId,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import {
  classifyTurnDiffFileOperations,
  parseTurnDiffFileRanges,
  parseTurnDiffFilesFromUnifiedDiff,
  parseTurnDiffRenameSources,
  parseTurnDiffUnsupportedPaths,
} from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import { findFileOverlaps, type ProvenanceMutation } from "../../provenance/FileOverlap.ts";
import { readPersistedProvenanceHistory } from "../../provenance/PersistedHistory.ts";
import { summarizeProvenanceTurn } from "../../provenance/TurnSummary.ts";
import { shouldAppendRevertFailure } from "../../provenance/FailureDedup.ts";
import { isProvenanceEnabled, worktreeMismatch } from "../../provenance/config.ts";
import { VcsDriverRegistry } from "../../vcs/VcsDriverRegistry.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function latestToolAction(
  activities: ReadonlyArray<{
    readonly turnId: TurnId | null;
    readonly kind: string;
    readonly summary: string;
  }>,
  turnId: TurnId,
): string {
  return (
    activities
      .toReversed()
      .find((activity) => activity.turnId === turnId && activity.kind === "tool.completed")
      ?.summary ?? "unknown"
  );
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const vcsDriverRegistry = yield* VcsDriverRegistry;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const startedTurns = new Map<ThreadId, TurnId>();
  const pending = new Set<ThreadId>();
  const provenanceHistory = new Map<string, Array<ProvenanceMutation>>();
  const hydratedProvenanceWorkspaces = new Set<string>();
  const activeProvenanceDiffFingerprints = new Map<string, string>();
  const turnBaselineDirtyFiles = new Map<string, ReadonlySet<string>>();
  const externalOverlapFingerprints = new Set<string>();
  const worktreeMismatchFingerprints = new Set<string>();
  // Provenance is additive to normal checkpointing and can be disabled for
  // operators diagnosing regressions without changing revert semantics.
  const provenanceEnabled = isProvenanceEnabled();

  const appendRevertFailureActivity = Effect.fn("appendRevertFailureActivity")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(input.threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (
      Option.isSome(thread) &&
      !shouldAppendRevertFailure(thread.value.activities, {
        turnCount: input.turnCount,
        detail: input.detail,
      })
    ) {
      return;
    }

    const { commandId, activityId } = yield* Effect.all({
      commandId: serverCommandId("checkpoint-revert-failure"),
      activityId: serverEventId,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId,
      threadId: input.threadId,
      activity: {
        id: activityId,
        tone: "error",
        kind: "checkpoint.revert.failed",
        summary: "Checkpoint revert failed",
        payload: {
          turnCount: input.turnCount,
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-capture-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.capture.failed",
            summary: "Checkpoint capture failed",
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  const ensureProvenanceHistory = Effect.fn("ensureProvenanceHistory")(function* (
    workspaceKey: string,
  ) {
    if (hydratedProvenanceWorkspaces.has(workspaceKey)) {
      return provenanceHistory.get(workspaceKey) ?? [];
    }
    const activities = projectionSnapshotQuery.getProvenanceActivities
      ? yield* projectionSnapshotQuery.getProvenanceActivities()
      : (yield* projectionSnapshotQuery.getSnapshot()).threads.flatMap((thread) => thread.activities);
    const history = [...readPersistedProvenanceHistory([{ activities }], workspaceKey)];
    provenanceHistory.set(workspaceKey, history);
    hydratedProvenanceWorkspaces.add(workspaceKey);
    return history;
  });
  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined, CheckpointStoreError> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!(yield* checkpointStore.isGitRepository(cwd))) {
      return undefined;
    }
    return cwd;
  });

  // Capture the completed turn's files, then publish its summary and receipts.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
        readonly text: string;
      }>;
      readonly session: { readonly providerName: string | null } | null;
      readonly activities: ReadonlyArray<{
        readonly turnId: TurnId | null;
        readonly kind: string;
        readonly summary: string;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.refresh(input.cwd);

    const { files, operationByPath, rangesByPath, renameSourceByPath, unsupportedPaths } =
      yield* checkpointStore
        .diffCheckpoints({
          cwd: input.cwd,
          fromCheckpointRef,
          toCheckpointRef: targetCheckpointRef,
          fallbackFromToHead: false,
          ignoreWhitespace: false,
        })
        .pipe(
          Effect.map((diff) => {
            const operationByPath = classifyTurnDiffFileOperations(diff);
            const rangesByPath = parseTurnDiffFileRanges(diff);
            const renameSourceByPath = parseTurnDiffRenameSources(diff);
            const parsedFiles = parseTurnDiffFilesFromUnifiedDiff(diff);
            const unsupportedPaths = parseTurnDiffUnsupportedPaths(diff);
            return {
              files: [
                ...parsedFiles.map((file) => ({
                  path: file.path,
                  kind: "modified" as const,
                  additions: file.additions,
                  deletions: file.deletions,
                })),
                ...unsupportedPaths
                  .filter((path) => !parsedFiles.some((file) => file.path === path))
                  .map((path) => ({ path, kind: "modified" as const, additions: 0, deletions: 0 })),
              ],
              operationByPath,
              rangesByPath,
              renameSourceByPath,
              unsupportedPaths,
            };
          }),
          Effect.tapError((error) =>
            appendCaptureFailureActivity({
              threadId: input.threadId,
              turnId: input.turnId,
              detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
              createdAt: input.createdAt,
            }),
          ),
          Effect.catch((error) =>
            Effect.logWarning("failed to derive checkpoint file summary", {
              threadId: input.threadId,
              turnId: input.turnId,
              turnCount: input.turnCount,
              detail: error.message,
            }).pipe(
              Effect.as({
                files: [],
                operationByPath: new Map<string, string>(),
                rangesByPath: new Map<
                  string,
                  ReadonlyArray<{ readonly start: number; readonly end: number }>
                >(),
                renameSourceByPath: new Map<string, string>(),
                unsupportedPaths: [] as ReadonlyArray<string>,
              }),
            ),
          ),
        );

    const currentMutations: Array<ProvenanceMutation> = files.map((file) => {
      const lineRanges = rangesByPath.get(file.path);
      const operation = operationByPath.get(file.path) ?? "modified";
      return {
        workspaceKey: input.cwd,
        threadId: input.threadId,
        turnId: input.turnId,
        checkpointTurnCount: input.turnCount,
        checkpointRef: targetCheckpointRef,
        completedAt: input.createdAt,
        providerName: input.thread.session?.providerName ?? "unknown",
        operation,
        action: latestToolAction(input.thread.activities, input.turnId),
        path: file.path,
        ...(renameSourceByPath.has(file.path)
          ? { previousPath: renameSourceByPath.get(file.path)! }
          : {}),
        ...(unsupportedPaths.includes(file.path) || operation === "renamed"
          ? { undoable: false }
          : {}),
        ...(lineRanges ? { lineRanges } : {}),
      };
    });
    const history = provenanceEnabled ? yield* ensureProvenanceHistory(input.cwd) : [];
    const turnSummary = summarizeProvenanceTurn(
      input.thread.messages
        .toReversed()
        .find((message) => message.role === "assistant" && message.turnId === input.turnId)?.text,
    );
    // Persist the complete turn-level mutation record so clients can review and
    // safely preview undo without relying on the in-memory overlap index.
    if (provenanceEnabled) {
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("provenance-turn-completed"),
        threadId: input.threadId,
        activity: {
          id: EventId.make(yield* randomUUID),
          tone: "info",
          kind: "provenance.turn.completed",
          summary: "Agent turn change set recorded",
          payload: {
            origin: "t3-provenance",
            workspaceKey: input.cwd,
            threadId: input.threadId,
            turnId: input.turnId,
            providerName: input.thread.session?.providerName ?? "unknown",
            beforeCheckpointRef: fromCheckpointRef,
            afterCheckpointRef: targetCheckpointRef,
            checkpointTurnCount: input.turnCount,
            completedAt: input.createdAt,
            status: input.status,
            ...(turnSummary ? { turnSummary } : {}),
            mutations: currentMutations,
          },
          turnId: input.turnId,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    }
    const overlaps = provenanceEnabled
      ? findFileOverlaps([...history, ...currentMutations]).filter(
          (overlap) =>
            overlap.later.threadId === input.threadId && overlap.later.turnId === input.turnId,
        )
      : [];
    if (provenanceEnabled) {
      provenanceHistory.set(input.cwd, [...history, ...currentMutations].slice(-2_000));
    }

    for (const overlap of overlaps) {
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("provenance-overlap"),
        threadId: input.threadId,
        activity: {
          id: EventId.make(yield* randomUUID),
          tone: "error",
          kind: "provenance.overlap.detected",
          summary: "Another T3 thread changed this file",
          payload: {
            origin: "t3-agent",
            workspaceKey: overlap.workspaceKey,
            path: overlap.path,
            earlierOperation: overlap.earlier.operation,
            currentOperation: overlap.later.operation,
            lineRanges: overlap.lineRanges,
            earlierAction: overlap.earlier.action,
            currentAction: overlap.later.action,
            earlierThreadId: overlap.earlier.threadId,
            earlierTurnId: overlap.earlier.turnId,
            earlierCheckpointTurnCount: overlap.earlier.checkpointTurnCount,
            earlierCheckpointRef: overlap.earlier.checkpointRef,
            earlierProvider: overlap.earlier.providerName,
            currentThreadId: overlap.later.threadId,
            currentTurnId: overlap.later.turnId,
            currentCheckpointTurnCount: overlap.later.checkpointTurnCount,
            currentCheckpointRef: overlap.later.checkpointRef,
            currentProvider: overlap.later.providerName,
            checkpointRef: overlap.later.checkpointRef,
            note: "Historical file overlap detected; inspect the diff before treating it as a conflict.",
          },
          turnId: input.turnId,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    }
    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Capture the files left by a completed or interrupted turn.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status:
          event.type === "turn.aborted"
            ? "ready"
            : checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: existingPlaceholder?.assistantMessageId ?? undefined,
        createdAt: event.createdAt,
      });
    },
  );

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: false,
      });
      if (!checkpointCwd) {
        return;
      }

      const baselineStatus = yield* vcsStatusBroadcaster.refreshLocalStatus(checkpointCwd).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to capture pre-turn workspace status for provenance", {
            threadId: thread.id,
            turnId,
            cwd: checkpointCwd,
            detail: error.message,
          }).pipe(Effect.as(null)),
        ),
      );
      if (baselineStatus !== null) {
        turnBaselineDirtyFiles.set(
          `${thread.id}:${turnId}`,
          new Set(baselineStatus.workingTree.files.map((file) => file.path)),
        );
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      if (baselineExists) {
        return;
      }

      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: event.createdAt,
      });
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    const local = yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (local !== null) {
      yield* followWorktreeBranchDrift({
        threadId: event.threadId,
        cwd: sessionRuntime.value.cwd,
        local,
      });
      yield* refreshPullRequestAfterTurn({
        threadId: event.threadId,
        turnId: toTurnId(event.turnId),
        cwd: sessionRuntime.value.cwd,
        local,
      });
    }
  });

  // Retry a missing PR after the agent finishes its push and PR creation.
  // Re-read the projected branch after drift adoption. A rejected metadata
  // update must not let this thread refresh another thread's checkout.
  const refreshPullRequestAfterTurn = Effect.fn("refreshPullRequestAfterTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || input.local.isDefaultRef) return;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(input.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread || thread.branch !== checkedOutBranch) return;
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, input.turnId)) return;
    yield* vcsStatusBroadcaster.refreshPullRequestStatus(input.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh pull request status after turn completion", {
          threadId: input.threadId,
          cwd: input.cwd,
          detail: error.message,
        }),
      ),
    );
  });

  // A `git checkout` run inside a thread's dedicated worktree (by an agent or
  // the user) bypasses T3's commands, so the thread's recorded branch goes
  // stale. Since #4460 the client only attributes PR state to a thread when
  // the checked-out branch equals the recorded one, so stale metadata silently
  // orphans the thread's PR. Follow the drift here: adopt the checked-out
  // branch as the thread's branch, but only when the worktree belongs to
  // exactly this thread — for shared cwds the strict matching is the point.
  const followWorktreeBranchDrift = Effect.fn("followWorktreeBranchDrift")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    // Detached HEAD has no branch to adopt; a temporary placeholder checkout
    // means the first-turn auto-rename is still in flight — don't race it.
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || isTemporaryWorktreeBranch(checkedOutBranch)) {
      return;
    }

    yield* Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === checkedOutBranch ||
        thread.worktreePath === null ||
        thread.worktreePath !== input.cwd ||
        isTemporaryWorktreeBranch(thread.branch)
      ) {
        return;
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot();
      const worktreeIsShared = shell.threads.some(
        (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
      );
      if (worktreeIsShared) {
        return;
      }

      // expectedBranch makes this a compare-and-swap in the decider: if the
      // recorded branch moved between our read and the dispatch (rename,
      // concurrent drift-follow), the stale update is dropped.
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-drift"),
        threadId: thread.id,
        branch: checkedOutBranch,
        expectedBranch: thread.branch,
      });
      yield* Effect.logInfo("thread branch followed worktree checkout", {
        threadId: thread.id,
        previousBranch: thread.branch,
        branch: checkedOutBranch,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("failed to follow worktree branch drift", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.metadata.historyImport === true ||
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    // Never capture provenance against the configured worktree when the live
    // provider session is running elsewhere. That would attribute unrelated
    // edits to this turn and make selective undo unsafe.
    if (provenanceEnabled && thread.worktreePath !== null) {
      const sessionRuntime = yield* resolveSessionRuntimeForThread(threadId);
      if (
        Option.isSome(sessionRuntime) &&
        worktreeMismatch(thread.worktreePath, sessionRuntime.value.cwd)
      ) {
        const mismatchKey = `${threadId}:${thread.worktreePath}:${sessionRuntime.value.cwd}`;
        if (!worktreeMismatchFingerprints.has(mismatchKey)) {
          worktreeMismatchFingerprints.add(mismatchKey);
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* serverCommandId("provenance-worktree-mismatch"),
            threadId,
            activity: {
              id: EventId.make(yield* randomUUID),
              tone: "error",
              kind: "provenance.worktree.mismatch.detected",
              summary: "Provider session is running in a different directory",
              payload: {
                origin: "t3-provenance",
                expectedWorktreePath: thread.worktreePath,
                actualCwd: sessionRuntime.value.cwd,
                threadId,
              },
              turnId: null,
              createdAt: event.occurredAt,
            },
            createdAt: event.occurredAt,
          });
        }
        return;
      }
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.payload.threadId);
    const configuredCheckpointCwd =
      event.payload.scope === "provenance-turn"
        ? yield* resolveCheckpointCwd({
            threadId: event.payload.threadId,
            thread,
            projects: yield* resolveThreadProjects(thread.projectId),
            preferSessionRuntime: false,
          })
        : undefined;
    const checkpointCwd =
      configuredCheckpointCwd ??
      Option.match(sessionRuntime, {
        onNone: () => undefined,
        onSome: (runtime) => runtime.cwd,
      });
    if (!checkpointCwd) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail:
          event.payload.scope === "provenance-turn"
            ? "Safe undo could not resolve a git checkout for this thread."
            : "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (!(yield* checkpointStore.isGitRepository(checkpointCwd))) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    if (event.payload.scope === "provenance-turn") {
      const alreadyReverted = thread.activities.some((activity) => {
        if (activity.kind !== "provenance.turn.reverted") return false;
        const payload = activity.payload as { readonly turnCount?: unknown };
        return payload.turnCount === event.payload.turnCount;
      });
      if (alreadyReverted) return;

      if (event.payload.turnCount === 0) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: "A provenance turn needs a pre-turn checkpoint to undo safely.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
      const beforeCheckpointRef = checkpointRefForThreadTurn(
        event.payload.threadId,
        event.payload.turnCount - 1,
      );
      const targetCheckpointRef = checkpointRefForThreadTurn(
        event.payload.threadId,
        event.payload.turnCount,
      );
      const vcsDriver = yield* vcsDriverRegistry.get("git");
      // A normal unified diff carries three context lines. If a later turn
      // changes one of those nearby lines, Git rejects a reversal even when
      // the target turn's actual edits are independent. A zero-context patch
      // contains only the target mutation; git apply still performs its own
      // all-or-nothing workspace check before we mutate anything.
      const reversePatchResult = yield* vcsDriver.execute({
        operation: "provenance.safeUndo.diff",
        cwd: checkpointCwd,
        args: [
          "diff",
          "--patch",
          "--unified=0",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          `${beforeCheckpointRef}^{commit}`,
          `${targetCheckpointRef}^{commit}`,
        ],
        allowNonZeroExit: true,
      });
      const reversePatch =
        reversePatchResult.exitCode === 0
          ? reversePatchResult.stdout
          : `__T3_SAFE_UNDO_ERROR__${reversePatchResult.stderr.trim() || "Checkpoint ref is unavailable for diff operation."}`;
      if (reversePatch.startsWith("__T3_SAFE_UNDO_ERROR__")) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: reversePatch.slice("__T3_SAFE_UNDO_ERROR__".length),
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
      const unsupportedUndoPaths = parseTurnDiffUnsupportedPaths(reversePatch);
      const containsRename = [...classifyTurnDiffFileOperations(reversePatch).values()].includes(
        "renamed",
      );
      if (reversePatch.trim().length === 0 || unsupportedUndoPaths.length > 0 || containsRename) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail:
            reversePatch.trim().length === 0
              ? "Safe undo stopped because this turn has no reversible text patch."
              : "Safe undo stopped because binary or renamed files require manual review.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
      const applicability = yield* vcsDriver.execute({
        operation: "provenance.safeUndo.check",
        cwd: checkpointCwd,
        args: ["apply", "--reverse", "--check", "--unidiff-zero", "--whitespace=nowarn"],
        stdin: reversePatch,
        allowNonZeroExit: true,
      });
      if (applicability.exitCode !== 0) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail:
            "Safe undo stopped because the current workspace conflicts with this turn. Review the diff and resolve it manually.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
      if (event.payload.preview === true) {
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: yield* serverCommandId("provenance-undo-preview"),
          threadId: event.payload.threadId,
          activity: {
            id: EventId.make(yield* randomUUID),
            tone: "info",
            kind: "provenance.turn.undo.previewed",
            summary: "Recovery preview is ready",
            payload: {
              origin: "t3-provenance",
              turnCount: event.payload.turnCount,
              paths: parseTurnDiffFilesFromUnifiedDiff(reversePatch).map((file) => file.path),
              checkedAt: now,
            },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        });
        return;
      }
      const applied = yield* vcsDriver.execute({
        operation: "provenance.safeUndo.apply",
        cwd: checkpointCwd,
        // Apply the exact operation that passed the safety check above. Using
        // --3way here makes Git consult the index and can fail even when the
        // checked reverse patch applies cleanly to the working tree.
        args: ["apply", "--reverse", "--unidiff-zero", "--whitespace=nowarn"],
        stdin: reversePatch,
        allowNonZeroExit: true,
      });
      if (applied.exitCode !== 0) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail:
            "Safe undo could not be applied cleanly. Review the diff and resolve it manually.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
      yield* workspaceEntries.refresh(checkpointCwd);
      yield* vcsStatusBroadcaster
        .refreshLocalStatus(checkpointCwd)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const revertedTurnId = thread.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
      )?.turnId;
      if (revertedTurnId) {
        const workspaceHistory = provenanceHistory.get(checkpointCwd) ?? [];
        provenanceHistory.set(
          checkpointCwd,
          workspaceHistory.filter(
            (mutation) =>
              mutation.threadId !== event.payload.threadId || mutation.turnId !== revertedTurnId,
          ),
        );
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("provenance-turn-reverted"),
        threadId: event.payload.threadId,
        activity: {
          id: EventId.make(yield* randomUUID),
          tone: "info",
          kind: "provenance.turn.reverted",
          summary: "Safe undo applied",
          payload: {
            origin: "t3-provenance",
            turnId: revertedTurnId,
            turnCount: event.payload.turnCount,
            beforeCheckpointRef,
            targetCheckpointRef,
            undoReceipt: {
              version: 1,
              scope: "code-only",
              appliedAt: now,
              patchSha256: NodeCrypto.createHash("sha256")
                .update(reversePatch, "utf8")
                .digest("hex"),
              paths: parseTurnDiffFilesFromUnifiedDiff(reversePatch).map((file) => file.path),
            },
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      });
      return;
    }

    if (Option.isNone(sessionRuntime)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const targetCheckpointRef =
      event.payload.turnCount === 0
        ? checkpointRefForThreadTurn(event.payload.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )?.checkpointRef;

    if (!targetCheckpointRef) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    yield* providerService.assertConversationRollbackSupported(event.payload.threadId);

    const restored = yield* checkpointStore.restoreCheckpoint({
      cwd: sessionRuntime.value.cwd,
      checkpointRef: targetCheckpointRef,
      fallbackToHead: event.payload.turnCount === 0,
    });
    if (!restored) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // Refresh the workspace entry index so the @-mention file picker
    // reflects the reverted filesystem state.
    yield* workspaceEntries.refresh(sessionRuntime.value.cwd);

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: sessionRuntime.value.threadId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs: Array<CheckpointRef> = [];
    for (const checkpoint of thread.checkpoints) {
      if (checkpoint.checkpointTurnCount > event.payload.turnCount) {
        staleCheckpointRefs.push(checkpoint.checkpointRef);
      }
    }

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: sessionRuntime.value.cwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: yield* serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      if (event.type === "thread.turn-start-requested") pending.add(event.payload.threadId);
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }
  });

  const publishLiveProvenance = Effect.fn("publishLiveProvenance")(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.diff.updated" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) return;

    const thread = yield* resolveThreadDetail(event.threadId);
    if (!thread) return;
    const projects = yield* resolveThreadProjects(thread.projectId);
    const cwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!cwd) return;

    const operationByPath = classifyTurnDiffFileOperations(event.payload.unifiedDiff);
    const rangesByPath = parseTurnDiffFileRanges(event.payload.unifiedDiff);
    const files = parseTurnDiffFilesFromUnifiedDiff(event.payload.unifiedDiff).map((file) => ({
      path: file.path,
      operation: operationByPath.get(file.path) ?? "modified",
      additions: file.additions,
      deletions: file.deletions,
      lineRanges: rangesByPath.get(file.path),
    }));
    if (files.length === 0) return;

    const baselineKey = `${event.threadId}:${turnId}`;
    const baselineDirtyFiles = turnBaselineDirtyFiles.get(baselineKey) ?? new Set<string>();
    const history = provenanceEnabled ? yield* ensureProvenanceHistory(cwd) : [];
    const externalCandidates = files.filter(
      (file) =>
        baselineDirtyFiles.has(file.path) &&
        !history.some((mutation) => mutation.path === file.path),
    );
    for (const file of externalCandidates) {
      const externalKey = `${baselineKey}:${file.path}`;
      if (externalOverlapFingerprints.has(externalKey)) continue;
      externalOverlapFingerprints.add(externalKey);
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("provenance-external-overlap"),
        threadId: event.threadId,
        activity: {
          id: EventId.make(yield* randomUUID),
          tone: "error",
          kind: "provenance.external.overlap.detected",
          summary: "Unknown external workspace change overlaps this turn",
          payload: {
            origin: "unknown-external",
            workspaceKey: cwd,
            path: file.path,
            operation: file.operation,
            lineRanges: file.lineRanges,
            currentThreadId: event.threadId,
            currentTurnId: turnId,
            currentProvider: thread.session?.providerName ?? event.provider,
            note: "The file was already dirty when this T3 turn started; the source is not identified.",
          },
          turnId,
          createdAt: event.createdAt,
        },
        createdAt: event.createdAt,
      });
    }

    const fingerprint = files
      .map((file) => [file.path, file.operation, file.additions, file.deletions].join("\u0000"))
      .join("\u0001");
    const fingerprintKey = `${event.threadId}:${turnId}`;
    if (activeProvenanceDiffFingerprints.get(fingerprintKey) === fingerprint) return;
    activeProvenanceDiffFingerprints.set(fingerprintKey, fingerprint);

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("provenance-live"),
      threadId: event.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "provenance.mutation.observed",
        summary: `${thread.session?.providerName ?? event.provider} is modifying ${files.length} file${files.length === 1 ? "" : "s"}`,
        payload: {
          origin: "t3-agent",
          workspaceKey: cwd,
          threadId: event.threadId,
          turnId,
          provider: thread.session?.providerName ?? event.provider,
          action: latestToolAction(thread.activities, turnId),
          files,
          note: "Live attribution is based on the provider's in-progress turn diff.",
        },
        turnId,
        createdAt: event.createdAt,
      },
      createdAt: event.createdAt,
    });
  });
  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "session.exited") {
      startedTurns.delete(event.threadId);
      pending.delete(event.threadId);
      return;
    }

    if (event.type === "turn.started") {
      const turnId = toTurnId(event.turnId);
      const activeTurnId = (yield* providerService.listSessions()).find((session) =>
        sameId(session.threadId, event.threadId),
      )?.activeTurnId;
      const mayReplace = pending.has(event.threadId) && sameId(activeTurnId, turnId);
      if (turnId !== null && (!startedTurns.has(event.threadId) || mayReplace)) {
        startedTurns.set(event.threadId, turnId);
        pending.delete(event.threadId);
      }
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.diff.updated") {
      yield* publishLiveProvenance(event);
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const completedKey = `${event.threadId}:${event.turnId ?? ""}`;
      activeProvenanceDiffFingerprints.delete(completedKey);
      turnBaselineDirtyFiles.delete(completedKey);
      for (const key of externalOverlapFingerprints) {
        if (key.startsWith(`${completedKey}:`)) externalOverlapFingerprints.delete(key);
      }
      const turnId = toTurnId(event.turnId);
      const thread = yield* resolveThreadDetail(event.threadId);
      const startedTurnId = startedTurns.get(event.threadId);
      const isTrackedTurn = sameId(startedTurnId, turnId);
      if (isTrackedTurn) startedTurns.delete(event.threadId);
      if (event.type === "turn.completed") {
        yield* refreshLocalGitStatusFromTurnCompletion(event);
      }
      if (
        turnId !== null &&
        thread !== undefined &&
        (isTrackedTurn ||
          sameId(thread.session?.activeTurnId, turnId) ||
          (startedTurnId === undefined && !thread.session?.activeTurnId))
      ) {
        pending.delete(event.threadId);
        yield* pullRequests.refreshAfterTurn;
      }
      if (
        event.type === "turn.aborted" &&
        !isTrackedTurn &&
        !sameId(thread?.session?.activeTurnId, turnId)
      ) {
        return;
      }
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<
    void,
    CheckpointStoreError | OrchestrationDispatchError | PlatformError.PlatformError,
    never
  > =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "turn.aborted" &&
          event.type !== "turn.diff.updated" &&
          event.type !== "session.exited"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
