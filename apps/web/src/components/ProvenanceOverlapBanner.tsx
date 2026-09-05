import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";
import { memo, useState } from "react";
import { AlertTriangleIcon, ArrowRightIcon, XIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import type { ConflictReviewTurn } from "../diffPanelStore";

type Props = {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly onDisableAlerts: () => void;
  readonly onInspect: (turnId: TurnId, filePath?: string) => void;
  readonly onCompare: (input: {
    readonly filePath: string;
    readonly lineRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
    readonly earlier: ConflictReviewTurn;
    readonly current: ConflictReviewTurn;
  }) => void;
};

type ProvenancePayload = {
  readonly path?: unknown;
  readonly workspaceKey?: unknown;
  readonly expectedWorktreePath?: unknown;
  readonly actualCwd?: unknown;
  readonly earlierProvider?: unknown;
  readonly earlierOperation?: unknown;
  readonly earlierAction?: unknown;
  readonly earlierTurnId?: unknown;
  readonly earlierThreadId?: unknown;
  readonly earlierCheckpointTurnCount?: unknown;
  readonly currentProvider?: unknown;
  readonly currentOperation?: unknown;
  readonly currentAction?: unknown;
  readonly currentTurnId?: unknown;
  readonly currentThreadId?: unknown;
  readonly currentCheckpointTurnCount?: unknown;
  readonly lineRanges?: unknown;
};

function latestOverlapActivity(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  return activities
    .toReversed()
    .find(
      (activity) =>
        activity.kind === "provenance.overlap.detected" ||
        activity.kind === "provenance.external.overlap.detected" ||
        activity.kind === "provenance.worktree.mismatch.detected",
    );
}

function readLineRanges(
  value: unknown,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const { start, end } = candidate as { readonly start?: unknown; readonly end?: unknown };
    if (typeof start !== "number" || typeof end !== "number") return [];
    return [{ start, end }];
  });
}

function formatLineRanges(value: unknown): string | undefined {
  const ranges = readLineRanges(value);
  const first = ranges[0];
  if (!first) return undefined;
  const label =
    first.start === first.end ? `Line ${first.start}` : `Lines ${first.start}–${first.end}`;
  return ranges.length === 1 ? label : `${label} +${ranges.length - 1} more`;
}

export const ProvenanceOverlapBanner = memo(function ProvenanceOverlapBanner({
  activities,
  onCompare,
  onDisableAlerts,
  onInspect,
}: Props) {
  const activity = latestOverlapActivity(activities);
  const initialPayload = activity?.payload as ProvenancePayload | undefined;
  const initialPath =
    typeof initialPayload?.path === "string" ? initialPayload.path : "workspace files";
  const initialWorkspaceKey =
    typeof initialPayload?.workspaceKey === "string" ? initialPayload.workspaceKey : "workspace";
  const initialScope = JSON.stringify(initialPayload?.lineRanges ?? []);
  const initialDismissalKey = `t3.provenance.dismissed.${encodeURIComponent(initialWorkspaceKey)}.${encodeURIComponent(initialPath)}.${encodeURIComponent(initialScope)}`;
  const [dismissedKey, setDismissedKey] = useState<string | null>(() =>
    typeof window !== "undefined" && window.localStorage.getItem(initialDismissalKey) === "1"
      ? initialDismissalKey
      : null,
  );
  if (!activity) return null;

  const payload = activity.payload as ProvenancePayload;
  const isExternal = activity.kind === "provenance.external.overlap.detected";
  const isWorktreeMismatch = activity.kind === "provenance.worktree.mismatch.detected";
  const isOverlap = !isExternal && !isWorktreeMismatch;
  const path = typeof payload.path === "string" ? payload.path : "workspace files";
  const workspaceKey =
    typeof payload.workspaceKey === "string"
      ? payload.workspaceKey
      : typeof payload.actualCwd === "string"
        ? payload.actualCwd
        : "workspace";
  const dismissalKey = `t3.provenance.dismissed.${encodeURIComponent(workspaceKey)}.${encodeURIComponent(path)}.${encodeURIComponent(JSON.stringify(payload.lineRanges ?? []))}`;
  if (dismissedKey === dismissalKey) return null;
  const earlierProvider =
    typeof payload.earlierProvider === "string" ? payload.earlierProvider : "Another agent";
  const earlierOperation =
    typeof payload.earlierOperation === "string" ? payload.earlierOperation : "modified";
  const earlierAction =
    typeof payload.earlierAction === "string" ? payload.earlierAction : undefined;
  const earlierTurnId =
    typeof payload.earlierTurnId === "string" ? (payload.earlierTurnId as TurnId) : undefined;
  const currentProvider =
    typeof payload.currentProvider === "string" ? payload.currentProvider : "This thread";
  const currentOperation =
    typeof payload.currentOperation === "string" ? payload.currentOperation : "modified";
  const currentAction =
    typeof payload.currentAction === "string" ? payload.currentAction : undefined;
  const currentTurnId =
    typeof payload.currentTurnId === "string" ? (payload.currentTurnId as TurnId) : activity.turnId;
  const lineScope = formatLineRanges(payload.lineRanges);
  const lineRanges = readLineRanges(payload.lineRanges);
  const turnId = activity.turnId;
  const sameProvider = !isExternal && earlierProvider === currentProvider;
  const conflictReview =
    isOverlap &&
    typeof payload.earlierThreadId === "string" &&
    typeof payload.earlierTurnId === "string" &&
    typeof payload.currentThreadId === "string" &&
    typeof payload.currentTurnId === "string"
      ? {
          filePath: path,
          lineRanges,
          earlier: {
            threadId: payload.earlierThreadId as ConflictReviewTurn["threadId"],
            turnId: payload.earlierTurnId as TurnId,
            checkpointTurnCount:
              typeof payload.earlierCheckpointTurnCount === "number"
                ? payload.earlierCheckpointTurnCount
                : null,
            providerName: earlierProvider,
            action: earlierAction ?? earlierOperation,
          },
          current: {
            threadId: payload.currentThreadId as ConflictReviewTurn["threadId"],
            turnId: payload.currentTurnId as TurnId,
            checkpointTurnCount:
              typeof payload.currentCheckpointTurnCount === "number"
                ? payload.currentCheckpointTurnCount
                : null,
            providerName: currentProvider,
            action: currentAction ?? currentOperation,
          },
        }
      : null;

  return (
    <Alert
      className="alert-glass @container/provenance pointer-events-auto mx-auto min-w-0 w-full max-w-3xl rounded-2xl border-border/45 px-4 py-3.5 shadow-[0_18px_46px_-32px_rgb(0_0_0/62%)] [&_[data-slot=alert-body]]:flex-wrap [&_[data-slot=alert-body]]:gap-x-3.5 [&_[data-slot=alert-body]]:gap-y-2.5 @sm/provenance:[&_[data-slot=alert-body]]:flex-nowrap [&_[data-slot=alert-icon]]:size-8 [&_[data-slot=alert-icon]]:rounded-lg [&_[data-slot=alert-icon]]:border-0 [&_[data-slot=alert-icon]]:bg-transparent [&_[data-slot=alert-icon]]:shadow-none [&_[data-slot=alert-icon]>svg]:size-4 [&_[data-slot=alert-content]]:gap-1"
      controlAlignment="first-line"
      actionPlacement="side"
      data-alert-queue-item="true"
      data-provenance-overlap="true"
      iconStyle="badge"
      role="status"
      variant="warning"
    >
      <AlertTriangleIcon aria-hidden="true" />
      <AlertTitle className="pe-1 text-sm font-semibold tracking-[-0.01em]">
        {isExternal
          ? "Unattributed workspace change"
          : isWorktreeMismatch
            ? "Provider directory mismatch"
            : "Overlapping changes detected"}
      </AlertTitle>
      <AlertDescription className="gap-1.5 text-xs leading-relaxed">
        <div>
          {isExternal ? (
            <>
              <code className="break-all font-mono text-foreground">{path}</code> was already
              modified when this turn started. T3 can’t verify its source.
            </>
          ) : isWorktreeMismatch ? (
            <>
              This thread is configured for{" "}
              <code className="break-all font-mono text-foreground">
                {String(payload.expectedWorktreePath ?? "an assigned worktree")}
              </code>
              , but the provider is running in{" "}
              <code className="break-all font-mono text-foreground">
                {String(payload.actualCwd ?? "another directory")}
              </code>
              . The turn was paused to protect attribution.
            </>
          ) : (
            <>
              <span className="@sm/provenance:hidden">
                Two turns changed{" "}
                <code className="break-all font-mono text-foreground">{path}</code> in the same
                area.
              </span>
              <span className="hidden @sm/provenance:inline">
                {sameProvider
                  ? `An earlier turn ${earlierOperation}`
                  : `${earlierProvider} previously ${earlierOperation}`}{" "}
                <code className="break-all font-mono text-foreground">{path}</code>. This turn is
                changing the same area.
              </span>
            </>
          )}
        </div>
        {!isWorktreeMismatch ? (
          <div className="inline-flex self-start text-[10px] font-medium text-warning-foreground/75">
            {lineScope ? lineScope : "Entire file"}
          </div>
        ) : null}
        {isOverlap ? (
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-[10px] text-muted-foreground @sm/provenance:hidden">
            <strong className="truncate text-foreground/85">{earlierProvider}</strong>
            <ArrowRightIcon className="size-3 shrink-0 opacity-60" aria-hidden="true" />
            <strong className="truncate text-foreground/85">
              {sameProvider ? "This turn" : currentProvider}
            </strong>
          </div>
        ) : null}
        {isOverlap ? (
          <div
            className="mt-1 hidden items-center gap-3 border-t border-border/30 pt-2 @sm/provenance:flex"
            aria-label="Competing thread changes"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Earlier
              </div>
              <div className="truncate text-foreground/90">
                <strong>{earlierProvider}</strong> · {earlierAction ?? earlierOperation}
              </div>
            </div>
            <ArrowRightIcon
              className="size-3 shrink-0 rotate-90 self-center text-muted-foreground/60 @sm/provenance:rotate-0"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Current
              </div>
              <div className="truncate text-foreground/90">
                <strong>{sameProvider ? "This thread" : currentProvider}</strong> ·{" "}
                {currentAction ?? currentOperation}
              </div>
            </div>
          </div>
        ) : null}{" "}
      </AlertDescription>
      <AlertAction className="ms-11 w-[calc(100%-2.75rem)] shrink-0 items-center justify-end gap-1.5 border-t border-border/35 pt-2.5 @sm/provenance:ms-1 @sm/provenance:w-auto @sm/provenance:self-stretch @sm/provenance:border-t-0 @sm/provenance:border-l @sm/provenance:ps-3.5 @sm/provenance:pt-0">
        {conflictReview ? (
          <Button
            className="rounded-full px-3.5"
            size="xs"
            variant="secondary"
            onClick={() => onCompare(conflictReview)}
          >
            <span className="@sm/provenance:hidden">Compare</span>
            <span className="hidden @sm/provenance:inline">Compare changes</span>
          </Button>
        ) : null}
        <Button className="rounded-full px-3" size="xs" variant="ghost" onClick={onDisableAlerts}>
          Don't show again
        </Button>
        <Button
          aria-label="Dismiss workspace overlap warning"
          onClick={() => {
            setDismissedKey(dismissalKey);
            if (typeof window !== "undefined") window.localStorage.setItem(dismissalKey, "1");
          }}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
      </AlertAction>
    </Alert>
  );
});
