import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";
import { CircleAlertIcon, FileSearchIcon, HistoryIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

type RevertFailurePayload = {
  readonly turnCount?: unknown;
  readonly detail?: unknown;
};

type RevertedPayload = {
  readonly turnCount?: unknown;
};

type ProvenanceTurnPayload = {
  readonly turnCount?: unknown;
};

export function findLatestUnresolvedSafeUndoFailure(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
) {
  const failureIndex = activities.findLastIndex(
    (activity) => activity.kind === "checkpoint.revert.failed",
  );
  if (failureIndex < 0) return undefined;

  const failure = activities[failureIndex]!;
  const payload = failure.payload as RevertFailurePayload;
  const failedTurnCount = typeof payload.turnCount === "number" ? payload.turnCount : undefined;
  const laterSuccess = activities.slice(failureIndex + 1).some((activity) => {
    if (activity.kind !== "provenance.turn.reverted") return false;
    const reverted = activity.payload as RevertedPayload;
    return failedTurnCount === undefined || reverted.turnCount === failedTurnCount;
  });
  return laterSuccess ? undefined : failure;
}

export const SafeUndoFailureAlert = memo(function SafeUndoFailureAlert({
  activities,
  onDisableAlerts,
  onOpenHistory,
  onInspect,
}: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly onDisableAlerts: () => void;
  readonly onOpenHistory: () => void;
  readonly onInspect: (turnId: TurnId) => void;
}) {
  const failure = findLatestUnresolvedSafeUndoFailure(activities);
  const [dismissedFailureId, setDismissedFailureId] = useState<string | null>(null);
  if (!failure || dismissedFailureId === failure.id) return null;

  const payload = failure.payload as RevertFailurePayload;
  const detail =
    typeof payload.detail === "string"
      ? payload.detail
      : "The workspace changed after this turn, so T3 left it untouched.";
  const turnLabel =
    typeof payload.turnCount === "number" ? `Turn ${payload.turnCount}` : "This turn";
  const turnId =
    failure.turnId ??
    activities.toReversed().find((activity) => {
      if (activity.kind !== "provenance.turn.completed" || !activity.turnId) return false;
      const completed = activity.payload as ProvenanceTurnPayload;
      return completed.turnCount === payload.turnCount;
    })?.turnId;

  return (
    <Alert
      actionPlacement="bottom"
      className="alert-glass @container/provenance pointer-events-auto mx-auto min-w-0 w-full max-w-3xl rounded-2xl border-border/45 px-4 py-3 shadow-[0_16px_42px_-30px_rgb(0_0_0/60%)] [&_[data-slot=alert-icon]]:size-7 [&_[data-slot=alert-icon]>svg]:size-3.5"
      controlAlignment="first-line"
      data-alert-queue-item="true"
      data-provenance-safe-undo-failure="true"
      iconStyle="badge"
      role="status"
      variant="warning"
    >
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle className="pe-1 text-[13px] font-medium tracking-[-0.01em]">
        Safe undo needs review
      </AlertTitle>
      <AlertDescription className="gap-1.5 text-[11px] leading-relaxed text-muted-foreground/85">
        <p>
          {turnLabel} was not changed. T3 stopped before applying a partial or ambiguous revert.
        </p>
        <p className="rounded-lg border border-foreground/[0.045] bg-foreground/[0.025] px-2.5 py-2 text-foreground/70">{detail}</p>
      </AlertDescription>
      <AlertAction className="w-full items-center justify-between gap-x-3 gap-y-1.5">
        <Button size="xs" variant="ghost" onClick={onOpenHistory}><HistoryIcon aria-hidden="true" />History</Button>
        <span className="flex items-center gap-1">
          {turnId ? <Button size="xs" variant="secondary" onClick={() => onInspect(turnId)}><FileSearchIcon aria-hidden="true" />Review diff</Button> : null}
          <Button size="xs" variant="ghost" onClick={onDisableAlerts}>Don't show again</Button>
          <Button aria-label="Dismiss safe undo review alert" size="icon-xs" variant="ghost" onClick={() => setDismissedFailureId(failure.id)}><XIcon aria-hidden="true" /></Button>
        </span>
      </AlertAction>
    </Alert>
  );
});
