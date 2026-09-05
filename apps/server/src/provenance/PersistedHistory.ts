import { CheckpointRef, ThreadId, TurnId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProvenanceFileRange, ProvenanceMutation } from "./FileOverlap.ts";

const PersistedRange = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
});

const PersistedMutation = Schema.Struct({
  workspaceKey: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  checkpointTurnCount: Schema.Number,
  checkpointRef: Schema.String,
  completedAt: Schema.String,
  providerName: Schema.String,
  operation: Schema.String,
  action: Schema.String,
  path: Schema.String,
  previousPath: Schema.optional(Schema.String),
  lineRanges: Schema.optional(Schema.Array(PersistedRange)),
  undoable: Schema.optional(Schema.Boolean),
});

const CompletedPayload = Schema.Struct({
  mutations: Schema.Array(PersistedMutation),
});

const RevertedPayload = Schema.Struct({
  turnId: Schema.optional(Schema.String),
});

const decodeCompletedPayload = Schema.decodeUnknownOption(CompletedPayload);
const decodeRevertedPayload = Schema.decodeUnknownOption(RevertedPayload);

function validLineRanges(
  ranges: ReadonlyArray<ProvenanceFileRange> | undefined,
): ReadonlyArray<ProvenanceFileRange> | undefined {
  if (!ranges) return undefined;
  return ranges.every(
    (range) =>
      Number.isSafeInteger(range.start) &&
      Number.isSafeInteger(range.end) &&
      range.start >= 1 &&
      range.end >= range.start,
  )
    ? ranges
    : undefined;
}

export type ProvenanceHistoryActivity = {
  readonly kind: string;
  readonly payload?: unknown;
};

/** Rebuilds the bounded overlap index from durable thread activities. */
export function readPersistedProvenanceHistory(
  threads: ReadonlyArray<{ readonly activities: ReadonlyArray<ProvenanceHistoryActivity> }>,
  workspaceKey: string,
  limit = 2_000,
): ReadonlyArray<ProvenanceMutation> {
  const revertedTurnIds = new Set<string>();
  const mutations: ProvenanceMutation[] = [];

  for (const thread of threads) {
    for (const activity of thread.activities) {
      if (activity.kind === "provenance.turn.reverted") {
        const decoded = decodeRevertedPayload(activity.payload);
        if (Option.isSome(decoded) && decoded.value.turnId) {
          revertedTurnIds.add(decoded.value.turnId);
        }
        continue;
      }
      if (activity.kind !== "provenance.turn.completed") continue;
      const decoded = decodeCompletedPayload(activity.payload);
      if (Option.isNone(decoded)) continue;
      for (const mutation of decoded.value.mutations) {
        if (mutation.workspaceKey !== workspaceKey) continue;
        const { lineRanges, previousPath, undoable, ...persisted } = mutation;
        const parsedLineRanges = validLineRanges(lineRanges);
        mutations.push({
          ...persisted,
          threadId: ThreadId.make(mutation.threadId),
          turnId: TurnId.make(mutation.turnId),
          checkpointRef: CheckpointRef.make(mutation.checkpointRef),
          ...(parsedLineRanges === undefined ? {} : { lineRanges: parsedLineRanges }),
          ...(previousPath === undefined ? {} : { previousPath }),
          ...(undoable === undefined ? {} : { undoable }),
        });
      }
    }
  }

  return mutations
    .filter((mutation) => !revertedTurnIds.has(mutation.turnId))
    .toSorted((left, right) => left.completedAt.localeCompare(right.completedAt))
    .slice(-Math.max(0, limit));
}
