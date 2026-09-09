import type {
  CheckpointRef,
  OrchestrationThreadActivity,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

export type ProvenanceFileRange = {
  readonly start: number;
  readonly end: number;
};

export type ProvenanceFileMutation = {
  readonly workspaceKey: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly checkpointRef: CheckpointRef;
  readonly checkpointTurnCount?: number;
  readonly beforeCheckpointRef?: CheckpointRef;
  readonly completedAt: string;
  readonly providerName: string;
  readonly operation: "created" | "modified" | "deleted" | "renamed";
  readonly action: string;
  readonly path: string;
  readonly previousPath?: string;
  readonly lineRanges?: ReadonlyArray<ProvenanceFileRange>;
  readonly undoable?: boolean;
};

export type ProvenanceTurnStatus = "running" | "completed" | "interrupted" | "error" | "reverted";

export type ProvenanceUndoReceipt = {
  readonly version: 1;
  readonly scope: "code-only";
  readonly appliedAt: string;
  readonly patchSha256: string;
  readonly paths: ReadonlyArray<string>;
  readonly recoveryWorkspaceRef?: CheckpointRef;
  readonly recoveryIndexRef?: CheckpointRef;
};

export type ProvenanceTurnChangeSet = {
  readonly workspaceKey: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly checkpointRef: CheckpointRef;
  readonly checkpointTurnCount?: number;
  readonly beforeCheckpointRef?: CheckpointRef;
  readonly completedAt: string;
  readonly providerName: string;
  readonly turnSummary?: string;
  readonly undoReceipt?: ProvenanceUndoReceipt;
  readonly mutations: ReadonlyArray<ProvenanceFileMutation>;
  readonly status: ProvenanceTurnStatus;
};

export type ProvenanceFileOverlap = {
  readonly workspaceKey: string;
  readonly path: string;
  readonly earlier: ProvenanceFileMutation;
  readonly later: ProvenanceFileMutation;
};

export type SafeUndoImpactKind = "remove" | "preserve" | "review";

export type SafeUndoImpact = {
  readonly path: string;
  readonly target: ProvenanceFileMutation;
  readonly later: ReadonlyArray<ProvenanceFileMutation>;
  readonly kind: SafeUndoImpactKind;
  readonly reason?: "later-overlap" | "lineage-uncertain";
};

export type SafeUndoPreview = {
  readonly target: ProvenanceTurnChangeSet;
  readonly impacts: ReadonlyArray<SafeUndoImpact>;
  readonly removable: ReadonlyArray<SafeUndoImpact>;
  readonly preserved: ReadonlyArray<ProvenanceFileMutation>;
  readonly conflicts: ReadonlyArray<SafeUndoImpact>;
  readonly canApply: boolean;
};

export type ProvenanceTurnScope = {
  /** Paths explicitly named in the user's request. */
  readonly requestedPaths: ReadonlyArray<string>;
  /** Files changed by the turn that were not explicitly named in that request. */
  readonly unrequestedPaths: ReadonlyArray<string>;
};

const MAX_PROVENANCE_TURNS_IN_MEMORY = 200;

const FILE_PATH_IN_REQUEST = /(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.[A-Za-z0-9]{1,10}/g;

function normalizeScopePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

/**
 * Compares recorded file mutations with file paths the user explicitly named.
 * It intentionally does not infer intent from prose: a scope warning is an
 * auditable prompt-to-diff fact, not an extra model judgement.
 */
export function describeProvenanceTurnScope(
  changeSet: ProvenanceTurnChangeSet,
  userRequest: string | undefined,
): ProvenanceTurnScope | undefined {
  if (!userRequest?.trim()) return undefined;
  const requestedPaths = [...new Set(userRequest.match(FILE_PATH_IN_REQUEST) ?? [])].map(
    normalizeScopePath,
  );
  if (requestedPaths.length === 0) return undefined;

  const changedPaths = [...new Set(changeSet.mutations.map((mutation) => mutation.path))];
  const unrequestedPaths = changedPaths.filter((changedPath) => {
    const normalizedChangedPath = normalizeScopePath(changedPath);
    return !requestedPaths.some(
      (requestedPath) =>
        requestedPath === normalizedChangedPath ||
        normalizedChangedPath.endsWith(`/${requestedPath}`) ||
        requestedPath.endsWith(`/${normalizedChangedPath}`),
    );
  });
  return { requestedPaths, unrequestedPaths };
}

export type ProvenanceLineOwner = {
  readonly mutation: ProvenanceFileMutation;
  /**
   * Ranges are captured from a completed checkpoint diff. They are useful
   * provenance evidence, but later edits can move a live line without a
   * content anchor, so they must never be presented as exact live blame.
   */
  readonly confidence: "recorded-range" | "file-only";
};

/** Finds the most recent turn recorded for this checkpoint-diff line range. */
export function findProvenanceLineOwner(
  mutations: ReadonlyArray<ProvenanceFileMutation>,
  path: string,
  line: number,
): ProvenanceLineOwner | undefined {
  const candidates = mutations
    .filter((mutation) => mutation.path === path)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  const exact = candidates.find((mutation) =>
    mutation.lineRanges?.some((range) => range.start <= line && line <= range.end),
  );
  if (exact) return { mutation: exact, confidence: "recorded-range" };
  const fileOnly = candidates.find((mutation) => !mutation.lineRanges?.length);
  return fileOnly ? { mutation: fileOnly, confidence: "file-only" } : undefined;
}

function compareMutations(left: ProvenanceFileMutation, right: ProvenanceFileMutation): number {
  const completedAt = left.completedAt.localeCompare(right.completedAt);
  if (completedAt !== 0) return completedAt;
  const threadId = left.threadId.localeCompare(right.threadId);
  return threadId !== 0 ? threadId : left.turnId.localeCompare(right.turnId);
}

function rangesIntersect(
  left: ReadonlyArray<ProvenanceFileRange> | undefined,
  right: ReadonlyArray<ProvenanceFileRange> | undefined,
): boolean {
  if (!left || !right || left.length === 0 || right.length === 0) return true;
  return left.some((leftRange) =>
    right.some(
      (rightRange) => leftRange.start <= rightRange.end && rightRange.start <= leftRange.end,
    ),
  );
}

function sameFile(left: ProvenanceFileMutation, right: ProvenanceFileMutation): boolean {
  if (left.workspaceKey !== right.workspaceKey) return false;
  const leftPaths = new Set([left.path, left.previousPath].filter(Boolean));
  return [right.path, right.previousPath].some((path) => path !== undefined && leftPaths.has(path));
}

/** Groups recorded mutations into inspectable, turn-level change sets. */
export function buildProvenanceTurnChangeSets(
  mutations: ReadonlyArray<ProvenanceFileMutation>,
): ReadonlyArray<ProvenanceTurnChangeSet> {
  const groups = new Map<string, ProvenanceTurnChangeSet>();
  for (const mutation of [...mutations].sort(compareMutations)) {
    const key = `${mutation.workspaceKey}\u0000${mutation.threadId}\u0000${mutation.turnId}`;
    const existing = groups.get(key);
    if (existing) {
      groups.set(key, { ...existing, mutations: [...existing.mutations, mutation] });
      continue;
    }
    groups.set(key, {
      workspaceKey: mutation.workspaceKey,
      threadId: mutation.threadId,
      turnId: mutation.turnId,
      checkpointRef: mutation.checkpointRef,
      ...(mutation.checkpointTurnCount !== undefined
        ? { checkpointTurnCount: mutation.checkpointTurnCount }
        : {}),
      ...(mutation.beforeCheckpointRef
        ? { beforeCheckpointRef: mutation.beforeCheckpointRef }
        : {}),
      completedAt: mutation.completedAt,
      providerName: mutation.providerName,
      mutations: [mutation],
      status: "completed",
    });
  }
  return [...groups.values()].sort((left, right) =>
    left.completedAt.localeCompare(right.completedAt),
  );
}

/**
 * Builds a non-destructive preview for removing one turn's file deltas.
 * Unknown or overlapping later edits are never marked safe to apply.
 */
export function buildSafeUndoPreview(
  target: ProvenanceTurnChangeSet,
  history: ReadonlyArray<ProvenanceFileMutation>,
): SafeUndoPreview {
  const impacts: Array<SafeUndoImpact> = [];
  const preservedByKey = new Map<string, ProvenanceFileMutation>();
  const targetMutations = new Set(target.mutations);
  for (const mutation of target.mutations) {
    const later = history.filter(
      (candidate) =>
        !targetMutations.has(candidate) &&
        sameFile(mutation, candidate) &&
        candidate.completedAt > target.completedAt,
    );
    const unsupported = mutation.operation === "renamed" || mutation.undoable === false;
    const conflicting =
      unsupported ||
      later.some((candidate) => rangesIntersect(mutation.lineRanges, candidate.lineRanges));
    const kind: SafeUndoImpactKind = conflicting ? "review" : "remove";
    impacts.push({
      path: mutation.path,
      target: mutation,
      later,
      kind,
      ...(conflicting
        ? {
            reason:
              unsupported ||
              later.some((candidate) => !mutation.lineRanges || !candidate.lineRanges)
                ? "lineage-uncertain"
                : "later-overlap",
          }
        : {}),
    });
    for (const candidate of later) {
      const key = `${candidate.workspaceKey}\u0000${candidate.path}\u0000${candidate.turnId}`;
      preservedByKey.set(key, candidate);
    }
  }
  const removable = impacts.filter((impact) => impact.kind === "remove");
  const conflicts = impacts.filter((impact) => impact.kind === "review");
  return {
    target,
    impacts,
    removable,
    preserved: [...preservedByKey.values()],
    conflicts,
    canApply: target.status === "completed" && conflicts.length === 0,
  };
}

/**
 * A line-range preview is deliberately conservative. When its only concern is
 * a recorded overlap (rather than missing lineage or an unsupported mutation),
 * the server may still prove the exact reverse patch is safe against the live
 * workspace. Callers must label this as a checked attempt, never as guaranteed
 * safe undo.
 */
export function canAttemptSafeUndo(preview: SafeUndoPreview): boolean {
  return (
    preview.target.status === "completed" &&
    preview.conflicts.every((impact) => impact.reason === "later-overlap")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseLineRanges(value: unknown): ReadonlyArray<ProvenanceFileRange> | undefined {
  if (!Array.isArray(value)) return undefined;
  const ranges: ProvenanceFileRange[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined;
    const start = candidate.start;
    const end = candidate.end;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start
    ) {
      return undefined;
    }
    ranges.push({ start, end });
  }
  return ranges;
}

function parseMutation(value: unknown): ProvenanceFileMutation | undefined {
  if (!isRecord(value)) return undefined;
  const operation = value.operation;
  if (
    typeof value.workspaceKey !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.checkpointRef !== "string" ||
    typeof value.completedAt !== "string" ||
    typeof value.providerName !== "string" ||
    typeof value.action !== "string" ||
    typeof value.path !== "string" ||
    (operation !== "created" &&
      operation !== "modified" &&
      operation !== "deleted" &&
      operation !== "renamed")
  ) {
    return undefined;
  }
  const lineRanges = parseLineRanges(value.lineRanges);
  return {
    workspaceKey: value.workspaceKey,
    threadId: value.threadId as ThreadId,
    turnId: value.turnId as TurnId,
    checkpointRef: value.checkpointRef as CheckpointRef,
    ...(typeof value.beforeCheckpointRef === "string"
      ? { beforeCheckpointRef: value.beforeCheckpointRef as CheckpointRef }
      : {}),
    ...(typeof value.checkpointTurnCount === "number"
      ? { checkpointTurnCount: value.checkpointTurnCount }
      : {}),
    completedAt: value.completedAt,
    providerName: value.providerName,
    operation,
    action: value.action,
    path: value.path,
    ...(typeof value.previousPath === "string" ? { previousPath: value.previousPath } : {}),
    ...(lineRanges ? { lineRanges } : {}),
    ...(value.undoable === false ? { undoable: false } : {}),
  };
}

function parseTurnStatus(value: unknown): ProvenanceTurnStatus {
  switch (value) {
    case "interrupted":
    case "error":
    case "reverted":
    case "running":
      return value;
    case "missing":
      return "interrupted";
    case "ready":
    case "completed":
    default:
      return "completed";
  }
}

function parseUndoReceipt(value: unknown): ProvenanceUndoReceipt | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== 1 ||
    value.scope !== "code-only" ||
    typeof value.appliedAt !== "string" ||
    Number.isNaN(Date.parse(value.appliedAt)) ||
    typeof value.patchSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.patchSha256) ||
    !Array.isArray(value.paths) ||
    value.paths.length === 0 ||
    !value.paths.every((path) => typeof path === "string" && path.trim().length > 0)
  ) {
    return undefined;
  }
  return {
    version: 1,
    scope: "code-only",
    appliedAt: value.appliedAt,
    patchSha256: value.patchSha256,
    paths: value.paths,
    ...(typeof value.recoveryWorkspaceRef === "string"
      ? { recoveryWorkspaceRef: value.recoveryWorkspaceRef as CheckpointRef }
      : {}),
    ...(typeof value.recoveryIndexRef === "string"
      ? { recoveryIndexRef: value.recoveryIndexRef as CheckpointRef }
      : {}),
  };
}

/** Reads durable turn ChangeSets from the activity stream, ignoring malformed payloads. */
export function readProvenanceTurnChangeSets(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<ProvenanceTurnChangeSet> {
  const mutations: ProvenanceFileMutation[] = [];
  const summaryByTurnId = new Map<TurnId, string>();
  const provenanceActivities = activities
    .filter((activity) => activity.kind === "provenance.turn.completed")
    .slice(-MAX_PROVENANCE_TURNS_IN_MEMORY);
  for (const activity of provenanceActivities) {
    if (!isRecord(activity.payload)) continue;
    const payload = activity.payload;
    if (!Array.isArray(payload.mutations)) continue;
    const beforeCheckpointRef =
      typeof payload.beforeCheckpointRef === "string"
        ? (payload.beforeCheckpointRef as CheckpointRef)
        : undefined;
    const checkpointTurnCount =
      typeof payload.checkpointTurnCount === "number" ? payload.checkpointTurnCount : undefined;
    if (
      activity.turnId &&
      typeof payload.turnSummary === "string" &&
      payload.turnSummary.trim().length > 0
    ) {
      summaryByTurnId.set(activity.turnId, payload.turnSummary.trim());
    }
    for (const candidate of payload.mutations) {
      const mutation = parseMutation(candidate);
      if (mutation) {
        mutations.push(
          beforeCheckpointRef || checkpointTurnCount !== undefined
            ? {
                ...mutation,
                ...(beforeCheckpointRef ? { beforeCheckpointRef } : {}),
                ...(checkpointTurnCount !== undefined ? { checkpointTurnCount } : {}),
              }
            : mutation,
        );
      }
    }
  }
  const undoReceiptByTurnId = new Map<TurnId, ProvenanceUndoReceipt | undefined>();
  for (const activity of activities) {
    if (!isRecord(activity.payload) || typeof activity.payload.turnId !== "string") continue;
    if (activity.kind === "provenance.turn.recovered") {
      undoReceiptByTurnId.delete(activity.payload.turnId as TurnId);
    } else if (activity.kind === "provenance.turn.reverted") {
      undoReceiptByTurnId.set(
        activity.payload.turnId as TurnId,
        parseUndoReceipt(activity.payload.undoReceipt),
      );
    }
  }
  return buildProvenanceTurnChangeSets(mutations).map((changeSet) => {
    const turnSummary = summaryByTurnId.get(changeSet.turnId);
    if (undoReceiptByTurnId.has(changeSet.turnId)) {
      const undoReceipt = undoReceiptByTurnId.get(changeSet.turnId);
      return {
        ...changeSet,
        ...(turnSummary ? { turnSummary } : {}),
        ...(undoReceipt ? { undoReceipt } : {}),
        status: "reverted",
      };
    }
    const activity = activities
      .toReversed()
      .find(
        (candidate) =>
          candidate.kind === "provenance.turn.completed" && candidate.turnId === changeSet.turnId,
      );
    return activity && isRecord(activity.payload)
      ? {
          ...changeSet,
          ...(turnSummary ? { turnSummary } : {}),
          status: parseTurnStatus(activity.payload.status),
        }
      : turnSummary
        ? { ...changeSet, turnSummary }
        : changeSet;
  });
}

/** Completed checkpoint diffs can identify overlap, not a live conflict or line ownership. */
export function findProvenanceFileOverlaps(
  mutations: ReadonlyArray<ProvenanceFileMutation>,
): ReadonlyArray<ProvenanceFileOverlap> {
  const latestByWorkspaceAndPath = new Map<string, ProvenanceFileMutation>();
  const overlaps: Array<ProvenanceFileOverlap> = [];
  for (const mutation of [...mutations].sort(compareMutations)) {
    const key = `${mutation.workspaceKey}\u0000${mutation.path}`;
    const previous = latestByWorkspaceAndPath.get(key);
    if (previous && previous.threadId !== mutation.threadId) {
      overlaps.push({
        workspaceKey: mutation.workspaceKey,
        path: mutation.path,
        earlier: previous,
        later: mutation,
      });
    }
    latestByWorkspaceAndPath.set(key, mutation);
  }
  return overlaps;
}
