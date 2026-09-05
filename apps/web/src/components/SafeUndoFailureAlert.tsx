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
      className="alert-glass @container/provenance pointer-events-auto mx-auto min-w-0 w-full max-w-3xl rounded-2xl border-border/45 px-4 py-3.5 shadow-[0_18px_46px_-32px_rgb(0_0_0/62%)] [&_[data-slot=alert-body]]:gap-3.5 [&_[data-slot=alert-icon]]:size-8 [&_[data-slot=alert-icon]]:rounded-lg [&_[data-slot=alert-icon]]:border-0 [&_[data-slot=alert-icon]]:bg-transparent [&_[data-slot=alert-icon]]:shadow-none [&_[data-slot=alert-icon]>svg]:size-4 [&_[data-slot=alert-content]]:gap-1 [&_[data-slot=alert-action-row]]:mt-3 [&_[data-slot=alert-action-row]]:border-border/40 [&_[data-slot=alert-action-row]]:pt-2.5"
      controlAlignment="first-line"
      data-alert-queue-item="true"
      data-provenance-safe-undo-failure="true"
      iconStyle="badge"
      role="status"
      variant="warning"
    >
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle className="pe-1 text-sm font-semibold tracking-[-0.01em]">
        Safe undo needs review
      </AlertTitle>
      <AlertDescription className="gap-1.5 text-[11px] leading-relaxed">
        <p>
          {turnLabel} was not changed. T3 stopped before applying a partial or ambiguous revert.
        </p>
        <p className="rounded-md bg-foreground/[0.035] px-2 py-1.5 text-foreground/75">{detail}</p>
      </AlertDescription>
      <AlertAction className="w-full flex-wrap justify-start gap-1 @sm/provenance:justify-end">
        <Button size="xs" variant="ghost" onClick={onOpenHistory}>
          <HistoryIcon aria-hidden="true" />
          Open provenance
        </Button>
        {turnId ? (
          <Button size="xs" variant="secondary" onClick={() => onInspect(turnId)}>
            <FileSearchIcon aria-hidden="true" />
            Review diff
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={onDisableAlerts}>
          Don't show again
        </Button>
        <Button
          aria-label="Dismiss safe undo review alert"
          size="icon-xs"
          variant="ghost"
          onClick={() => setDismissedFailureId(failure.id)}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </AlertAction>
    </Alert>
  );
});
