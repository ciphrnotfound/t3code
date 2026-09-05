import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";
import { memo, useState } from "react";
import {
  HistoryIcon,
  LoaderCircleIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";
import {
  buildSafeUndoPreview,
  canAttemptSafeUndo,
  describeProvenanceTurnScope,
  readProvenanceTurnChangeSets,
} from "@t3tools/client-runtime/state/provenance";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

type Props = {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly onDisableAlerts: () => void;
  readonly onInspect: (turnId: TurnId, filePath?: string) => void;
  readonly onOpenHistory?: () => void;
  readonly onPreviewUndo?: (turnCount: number) => boolean | void | Promise<boolean | void>;
  readonly onUndoTurn?: (turnCount: number) => void;
  readonly userRequestByTurnId?: ReadonlyMap<TurnId, string>;
};

export const ProvenanceTurnReviewCard = memo(function ProvenanceTurnReviewCard({
  activities,
  onDisableAlerts,
  onInspect,
  onOpenHistory,
  onPreviewUndo,
  onUndoTurn,
  userRequestByTurnId,
}: Props) {
  const changeSets = readProvenanceTurnChangeSets(activities);
  const activeChangeSets = changeSets.filter((changeSet) => changeSet.status !== "reverted");
  const target = activeChangeSets.at(-1);
  const [expanded, setExpanded] = useState(false);
  const [dismissedTurnId, setDismissedTurnId] = useState<TurnId | null>(null);
  const [previewingTurnId, setPreviewingTurnId] = useState<TurnId | null>(null);
  const [previewedTurnId, setPreviewedTurnId] = useState<TurnId | null>(null);
  if (!target || target.turnId === dismissedTurnId || target.mutations.length === 0) return null;

  const preview = buildSafeUndoPreview(
    target,
    activeChangeSets.flatMap((changeSet) => changeSet.mutations),
  );
  const fileCount = new Set(target.mutations.map((mutation) => mutation.path)).size;
  const firstPath = target.mutations[0]?.path;
  const firstAction = target.mutations[0]?.action;
  const timeline = changeSets.slice(-5).toReversed();
  const lineageComplete = target.status === "completed";
  const canApplySafeUndo =
    lineageComplete && canAttemptSafeUndo(preview) && target.checkpointTurnCount !== undefined;
  const safeUndoNeedsServerCheck = canApplySafeUndo && !preview.canApply;
  const latestPreview = activities.toReversed().find((activity) => {
    if (activity.kind !== "provenance.turn.undo.previewed") return false;
    const payload = activity.payload as { readonly turnCount?: unknown };
    return payload.turnCount === target.checkpointTurnCount;
  });
  const hasRecoveryPreview = latestPreview !== undefined || previewedTurnId === target.turnId;
  const isPreviewingRecovery = previewingTurnId === target.turnId;
  const turnLabel =
    target.checkpointTurnCount === undefined ? "" : ` · turn ${target.checkpointTurnCount}`;
  const scope = describeProvenanceTurnScope(target, userRequestByTurnId?.get(target.turnId));
  const unrequestedFileCount = scope?.unrequestedPaths.length ?? 0;

  return (
    <Alert
      className="alert-glass @container/provenance pointer-events-auto mx-auto min-w-0 w-full max-w-3xl rounded-2xl border-border/45 px-4 py-3.5 shadow-[0_18px_46px_-32px_rgb(0_0_0/62%)] [&_[data-slot=alert-body]]:gap-3.5 [&_[data-slot=alert-icon]]:size-8 [&_[data-slot=alert-icon]]:rounded-lg [&_[data-slot=alert-icon]]:border-0 [&_[data-slot=alert-icon]]:bg-transparent [&_[data-slot=alert-icon]]:shadow-none [&_[data-slot=alert-icon]>svg]:size-4 [&_[data-slot=alert-content]]:gap-1 [&_[data-slot=alert-action-row]]:mt-3 [&_[data-slot=alert-action-row]]:border-border/40 [&_[data-slot=alert-action-row]]:pt-2.5"
      controlAlignment="first-line"
      actionPlacement="bottom"
      data-alert-queue-item="true"
      data-provenance-turn-review="true"
      iconStyle="badge"
      role="status"
      variant={lineageComplete ? "info" : "warning"}
    >
      <HistoryIcon aria-hidden="true" />
      <AlertTitle className="pe-1 text-sm font-semibold tracking-[-0.01em]">
        Changes from {target.providerName}
        {turnLabel}
      </AlertTitle>
      <AlertDescription className="gap-2 text-[11px] leading-relaxed">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground">
          <span className="font-medium text-foreground/90">
            {fileCount} {fileCount === 1 ? "file" : "files"}
          </span>
          <span aria-hidden="true" className="text-border">
            /
          </span>
          <span>{lineageComplete ? "Ready to review" : "Incomplete · undo paused"}</span>
          {firstAction ? (
            <>
              <span aria-hidden="true" className="text-border">
                /
              </span>
              <span className="max-w-48 truncate">{firstAction}</span>
            </>
          ) : null}
        </div>
        {target.turnSummary ? (
          <p className="line-clamp-2 max-w-[32rem] text-[11px] leading-[1.55] text-foreground/75">
            {target.turnSummary}
          </p>
        ) : null}
        {scope ? (
          <div
            className="flex min-w-0 items-center gap-1.5 rounded-md bg-foreground/[0.035] px-2 py-1.5 text-[10px]"
            aria-label={
              unrequestedFileCount === 0
                ? `Scope check passed: all ${fileCount} changed ${fileCount === 1 ? "file was" : "files were"} named in the request`
                : `Scope check needs review: ${unrequestedFileCount} changed ${unrequestedFileCount === 1 ? "file was" : "files were"} not named in the request`
            }
          >
            {unrequestedFileCount === 0 ? (
              <ShieldCheckIcon className="size-3 shrink-0 text-success" aria-hidden="true" />
            ) : (
              <ShieldAlertIcon className="size-3 shrink-0 text-warning" aria-hidden="true" />
            )}
            <span className="font-medium text-foreground/80">Scope</span>
            <span className="min-w-0 truncate text-muted-foreground">
              {unrequestedFileCount === 0
                ? `All ${fileCount} changed ${fileCount === 1 ? "file was" : "files were"} named in the request`
                : `${unrequestedFileCount} ${unrequestedFileCount === 1 ? "file was" : "files were"} not named in the request`}
            </span>
          </div>
        ) : null}
        {isPreviewingRecovery ? (
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-info/20 bg-info/8 px-2.5 py-2 text-[11px] text-info-foreground/85">
            <LoaderCircleIcon
              className="size-3.5 shrink-0 animate-spin text-info"
              aria-hidden="true"
            />
            <span className="font-medium">Checking the workspace and later changes…</span>
          </div>
        ) : hasRecoveryPreview ? (
          <div className="flex min-w-0 items-start gap-2 rounded-lg border border-success/20 bg-success/8 px-2.5 py-2 text-[11px] text-foreground/85">
            <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
            <span className="min-w-0">
              <strong className="block font-medium text-success">Recovery check passed</strong>
              <span className="block text-[10px] text-muted-foreground">
                This turn can be removed without changing the workspace preview or losing compatible
                later work.
              </span>
            </span>
          </div>
        ) : null}
        {expanded ? (
          <div
            className="mt-1 max-h-[min(24vh,8rem)] space-y-3 overflow-y-auto pe-1 [scrollbar-width:thin]"
            aria-label="Safe undo preview"
          >
            <div className="flex flex-wrap gap-1.5" aria-label="Safe undo preview summary">
              <span className="inline-flex items-center gap-1 rounded-full bg-success/8 px-2 py-1 font-medium text-success">
                Remove <strong>{preview.removable.length}</strong>
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-info/8 px-2 py-1 font-medium text-info">
                Preserve <strong>{preview.preserved.length}</strong>
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-warning/8 px-2 py-1 font-medium text-warning">
                Review <strong>{preview.conflicts.length}</strong>
              </span>
            </div>
            <div className="space-y-1.5" aria-label="Thread change timeline">
              <div className="text-[11px] font-medium text-foreground/80">Recent turns</div>
              <div className="divide-y divide-border/40 rounded-lg bg-foreground/[0.035] px-2">
                {timeline.map((changeSet) => {
                  const path = changeSet.mutations[0]?.path;
                  const turnPreview = buildSafeUndoPreview(
                    changeSet,
                    activeChangeSets.flatMap((item) => item.mutations),
                  );
                  const canUndoTurn =
                    onUndoTurn &&
                    changeSet.status === "completed" &&
                    changeSet.checkpointTurnCount !== undefined &&
                    canAttemptSafeUndo(turnPreview);
                  const canReviewTurn =
                    changeSet.status === "completed" &&
                    changeSet.checkpointTurnCount !== undefined &&
                    !turnPreview.canApply &&
                    path;
                  return (
                    <div
                      className="flex min-h-8 items-center gap-1 py-1"
                      key={`${changeSet.threadId}-${changeSet.turnId}`}
                    >
                      <button
                        aria-label={`Review ${changeSet.providerName} turn ${changeSet.checkpointTurnCount ?? ""} changes${path ? ` in ${path}` : ""}`}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        onClick={() => path && onInspect(changeSet.turnId, path)}
                        disabled={!path}
                        type="button"
                      >
                        <span className="truncate font-medium text-foreground/90">
                          {changeSet.providerName}
                        </span>
                        <span className="min-w-0 truncate text-muted-foreground">
                          {changeSet.mutations[0]?.action ?? "Changed files"} ·{" "}
                          {changeSet.mutations.length} file
                          {changeSet.mutations.length === 1 ? "" : "s"}
                        </span>
                        <span className="ms-auto shrink-0 font-mono text-[9px] text-muted-foreground/70">
                          {changeSet.status === "reverted"
                            ? "undone"
                            : changeSet.turnId.slice(0, 8)}
                        </span>
                      </button>
                      {canUndoTurn ? (
                        <Button
                          aria-label={`Undo ${changeSet.providerName} turn ${changeSet.checkpointTurnCount}`}
                          size="xs"
                          variant="ghost"
                          onClick={() => onUndoTurn(changeSet.checkpointTurnCount!)}
                        >
                          {turnPreview.canApply ? "Undo" : "Check & undo"}
                        </Button>
                      ) : canReviewTurn ? (
                        <Button
                          aria-label={`Review why ${changeSet.providerName} turn ${changeSet.checkpointTurnCount} cannot be undone safely`}
                          size="xs"
                          variant="ghost"
                          onClick={() => onInspect(changeSet.turnId, path)}
                        >
                          Review
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="text-[11px] font-medium text-foreground/80">Turn ownership</div>
            <div className="divide-y divide-border/40 rounded-lg bg-foreground/[0.035]">
              {preview.impacts.map((impact) => (
                <button
                  className="flex min-h-9 w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left hover:bg-muted/30"
                  key={`${impact.path}-${impact.target.turnId}`}
                  onClick={() => onInspect(target.turnId, impact.path)}
                  type="button"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-foreground/90">
                      {impact.path}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {impact.target.providerName} · turn {impact.target.checkpointTurnCount ?? "?"}
                    </span>
                  </span>
                  <span
                    className={
                      impact.kind === "remove"
                        ? "shrink-0 text-success"
                        : impact.kind === "preserve"
                          ? "shrink-0 text-info"
                          : "shrink-0 text-warning"
                    }
                  >
                    {impact.kind === "remove"
                      ? "safe to remove"
                      : impact.kind === "preserve"
                        ? "preserve"
                        : impact.reason === "lineage-uncertain"
                          ? "manual review"
                          : "review overlap"}
                  </span>
                </button>
              ))}
            </div>
            {preview.preserved.length > 0 ? (
              <div className="text-[11px] text-muted-foreground">
                Preserved later work: {preview.preserved.map((item) => item.path).join(", ")}
              </div>
            ) : null}
            <div className="text-[10px] leading-relaxed text-muted-foreground">
              {preview.canApply
                ? "Undo removes this turn's workspace patch while preserving conversation history and later non-overlapping work."
                : "Undo is paused until the overlapping changes are reviewed."}
            </div>
          </div>
        ) : null}
      </AlertDescription>
      <AlertAction className="w-full flex-wrap justify-start gap-1 @sm/provenance:justify-end">
        {onOpenHistory ? (
          <Button size="xs" variant="ghost" onClick={onOpenHistory}>
            <HistoryIcon aria-hidden="true" />
            History
          </Button>
        ) : null}
        <Button
          disabled={!lineageComplete}
          size="xs"
          variant="ghost"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Hide preview" : "Preview undo"}
        </Button>
        {onPreviewUndo && canApplySafeUndo && !hasRecoveryPreview ? (
          <Button
            disabled={isPreviewingRecovery}
            size="xs"
            variant="secondary"
            onClick={async () => {
              setExpanded(true);
              setPreviewingTurnId(target.turnId);
              try {
                const succeeded = await onPreviewUndo(target.checkpointTurnCount!);
                if (succeeded !== false) setPreviewedTurnId(target.turnId);
              } finally {
                setPreviewingTurnId(null);
              }
            }}
          >
            {isPreviewingRecovery ? (
              <>
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                Checking…
              </>
            ) : (
              "Preview recovery"
            )}
          </Button>
        ) : null}
        {firstPath ? (
          <Button size="xs" variant="ghost" onClick={() => onInspect(target.turnId, firstPath)}>
            Review changes
          </Button>
        ) : null}
        {onUndoTurn && canApplySafeUndo ? (
          <Button
            size="xs"
            variant="destructive"
            onClick={() => onUndoTurn(target.checkpointTurnCount!)}
          >
            {hasRecoveryPreview
              ? "Apply undo"
              : safeUndoNeedsServerCheck
                ? "Check & undo"
                : "Undo code changes"}
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={onDisableAlerts}>
          Don't show again
        </Button>
        <Button
          aria-label="Dismiss turn change review"
          onClick={() => setDismissedTurnId(target.turnId)}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
      </AlertAction>
    </Alert>
  );
});
