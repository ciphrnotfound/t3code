export type ConflictReviewLineRange = {
  readonly start: number;
  readonly end: number;
};

export function formatConflictReviewScope(ranges: ReadonlyArray<ConflictReviewLineRange>): string {
  if (ranges.length === 0) return "Entire file requires review";
  const visible = ranges.slice(0, 2).map((range) =>
    range.start === range.end ? `Line ${range.start}` : `Lines ${range.start}–${range.end}`,
  );
  const remaining = ranges.length - visible.length;
  return remaining > 0 ? `${visible.join(", ")} +${remaining} more` : visible.join(", ");
}

export type ConflictReviewActor = {
  readonly providerName: string;
  readonly threadTitle?: string;
  readonly checkpointTurnCount?: number | null;
  readonly turnId: string;
};

function formatConflictActor(actor: ConflictReviewActor): string {
  const turnLabel = actor.checkpointTurnCount == null ? `turn ${actor.turnId.slice(0, 8)}` : `turn ${actor.checkpointTurnCount}`;
  const identity = `${actor.providerName} · ${turnLabel}`;
  const title = actor.threadTitle?.trim();
  return title && title !== actor.providerName ? `${title} (${identity})` : identity;
}

export function describeConflictIntegrationOrder(input: {
  readonly earlier: ConflictReviewActor;
  readonly current: ConflictReviewActor;
  readonly sameThread: boolean;
}): { readonly title: string; readonly detail: string } {
  return input.sameThread
    ? { title: "Keep the earlier turn as the base", detail: "Review the current turn second and reconcile only its overlapping region." }
    : {
        title: `Integrate ${formatConflictActor(input.earlier)} first, then ${formatConflictActor(input.current)}`,
        detail: "The current turn was recorded later, so reconcile it against the earlier result.",
      };
}
