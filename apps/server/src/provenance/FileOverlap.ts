import type { CheckpointRef, ThreadId, TurnId } from "@t3tools/contracts";

export type ProvenanceFileRange = {
  readonly start: number;
  readonly end: number;
};

export type ProvenanceMutation = {
  readonly workspaceKey: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly completedAt: string;
  readonly providerName: string;
  readonly operation: string;
  readonly action: string;
  readonly path: string;
  readonly previousPath?: string;
  readonly undoable?: boolean;
  readonly lineRanges?: ReadonlyArray<ProvenanceFileRange>;
};

export type ProvenanceOverlap = {
  readonly workspaceKey: string;
  readonly path: string;
  readonly earlier: ProvenanceMutation;
  readonly later: ProvenanceMutation;
  readonly lineRanges: ReadonlyArray<ProvenanceFileRange>;
};

function compare(left: ProvenanceMutation, right: ProvenanceMutation): number {
  const time = left.completedAt.localeCompare(right.completedAt);
  if (time !== 0) return time;
  return left.threadId.localeCompare(right.threadId) || left.turnId.localeCompare(right.turnId);
}

function intersectRanges(
  left: ReadonlyArray<ProvenanceFileRange> | undefined,
  right: ReadonlyArray<ProvenanceFileRange> | undefined,
): ReadonlyArray<ProvenanceFileRange> {
  if (!left || !right) return [];
  const intersections: Array<ProvenanceFileRange> = [];
  for (const leftRange of left) {
    for (const rightRange of right) {
      const start = Math.max(leftRange.start, rightRange.start);
      const end = Math.min(leftRange.end, rightRange.end);
      if (start <= end) intersections.push({ start, end });
    }
  }
  return intersections;
}

function mutationPaths(mutation: ProvenanceMutation): ReadonlyArray<string> {
  return mutation.previousPath ? [mutation.path, mutation.previousPath] : [mutation.path];
}

/**
 * Finds historical file/range overlap only. Callers must not present this as
 * a live conflict unless the actors are still active.
 */
export function findFileOverlaps(
  mutations: ReadonlyArray<ProvenanceMutation>,
): ReadonlyArray<ProvenanceOverlap> {
  const history = new Map<string, Array<ProvenanceMutation>>();
  const result: Array<ProvenanceOverlap> = [];
  for (const mutation of [...mutations].sort(compare)) {
    const keys = mutationPaths(mutation).map((path) => `${mutation.workspaceKey}\u0000${path}`);
    // Keep older regions discoverable after an unrelated edit to the same file.
    // Emit only the newest matching historical owner to keep alerts bounded.
    const earlier = keys
      .map((key) =>
        history
          .get(key)
          ?.findLast(
            (candidate) =>
              candidate.threadId !== mutation.threadId &&
              (candidate.operation === "renamed" ||
                mutation.operation === "renamed" ||
                !candidate.lineRanges?.length ||
                !mutation.lineRanges?.length ||
                intersectRanges(candidate.lineRanges, mutation.lineRanges).length > 0),
          ),
      )
      .filter((candidate): candidate is ProvenanceMutation => candidate !== undefined)
      .toSorted(compare)
      .at(-1);
    if (earlier) {
      const lineRanges = intersectRanges(earlier.lineRanges, mutation.lineRanges);
      result.push({
        workspaceKey: mutation.workspaceKey,
        path: mutation.path,
        earlier,
        later: mutation,
        lineRanges,
      });
    }
    for (const key of keys) {
      const entries = history.get(key);
      if (entries) entries.push(mutation);
      else history.set(key, [mutation]);
    }
  }
  return result;
}
