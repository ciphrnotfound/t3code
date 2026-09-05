import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";
import { memo, useState } from "react";
import {
  HistoryIcon,
  LoaderCircleIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Undo2Icon,
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
      className="alert-glass @container/provenance pointer-events-auto mx-auto min-w-0 w-full max-w-3xl rounded-2xl border-border/45 px-4 py-3 shadow-[0_16px_42px_-30px_rgb(0_0_0/60%)] [&_[data-slot=alert-icon]]:size-7 [&_[data-slot=alert-icon]>svg]:size-3.5"
      controlAlignment="first-line"
      actionPlacement="bottom"
      data-alert-queue-item="true"
      data-provenance-turn-review="true"
      iconStyle="badge"
      role="status"
      variant={lineageComplete ? "info" : "warning"}
    >
      <Undo2Icon aria-hidden="true" />
      <AlertTitle className="pe-1 text-[13px] font-medium tracking-[-0.01em]">
        Changes from {target.providerName}
        {turnLabel}
      </AlertTitle>
      <AlertDescription className="gap-1.5 text-[11px] leading-relaxed">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground/85">
          <span className="text-foreground/85">
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
          <p className="line-clamp-2 max-w-[34rem] text-[11px] leading-[1.55] text-foreground/70">
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
            <span className="text-foreground/75">Scope</span>
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
            <span>Checking the workspace and later changes…</span>
          </div>
        ) : hasRecoveryPreview ? (
          <div className="flex min-w-0 items-center gap-2 rounded-xl border border-success/18 bg-success/[0.055] px-2.5 py-2 text-[11px] text-foreground/80">
            <ShieldCheckIcon className="size-3.5 shrink-0 text-success" aria-hidden="true" />
            <span className="min-w-0">
              <span className="text-success">Recovery check passed</span>
              <span className="ms-1.5 text-[10px] text-muted-foreground">
                Safe to remove without disturbing compatible later work.
              </span>
            </span>
          </div>
        ) : null}
        {expanded ? (
          <div
            className="mt-1 max-h-[min(38vh,18rem)] space-y-3 overflow-y-auto pe-1 [scrollbar-width:thin]"
            aria-label="Safe undo preview"
          >
            <div className="grid grid-cols-3 divide-x divide-border/45 overflow-hidden rounded-xl border border-border/45 bg-foreground/[0.025]" aria-label="Safe undo preview summary">
              <div className="px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-[0.07em] text-foreground/55">Remove</div>
                <div className="mt-0.5 text-sm tabular-nums text-success">{preview.removable.length}</div>
              </div>
              <div className="px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-[0.07em] text-foreground/55">Keep</div>
                <div className="mt-0.5 text-sm tabular-nums text-info">{preview.preserved.length}</div>
              </div>
              <div className="px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-[0.07em] text-foreground/55">Review</div>
                <div className="mt-0.5 text-sm tabular-nums text-warning">{preview.conflicts.length}</div>
              </div>
            </div>
            <div className="space-y-1.5" aria-label="Thread change timeline">
              <div className="text-[9px] uppercase tracking-[0.08em] text-muted-foreground/80">Recent turns</div>
              <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/40 bg-foreground/[0.02]">
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
                      className="flex min-h-9 items-center gap-2 px-2.5 py-1"
                      key={`${changeSet.threadId}-${changeSet.turnId}`}
                    >
                      <button
                        aria-label={`Review ${changeSet.providerName} turn ${changeSet.checkpointTurnCount ?? ""} changes${path ? ` in ${path}` : ""}`}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => path && onInspect(changeSet.turnId, path)}
                        disabled={!path}
                        type="button"
                      >
                        <span className="inline-flex shrink-0 rounded-md bg-foreground/[0.055] px-1.5 py-0.5 text-[9px] text-foreground/75">
                          Turn {changeSet.checkpointTurnCount ?? "?"}
                        </span>
                        <span className="min-w-0 truncate text-muted-foreground/85">
                          {changeSet.providerName} · {changeSet.mutations[0]?.action ?? "Changed files"} · {changeSet.mutations.length} file
                          {changeSet.mutations.length === 1 ? "" : "s"}
                        </span>
                        {changeSet.status === "reverted" ? <span className="ms-auto shrink-0 text-[9px] text-muted-foreground/70">undone</span> : null}
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
            <div className="text-[9px] uppercase tracking-[0.08em] text-muted-foreground/80">Turn ownership</div>
            <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/40 bg-foreground/[0.02]">
              {preview.impacts.map((impact) => (
                <button
                  className="flex min-h-10 w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/25"
                  key={`${impact.path}-${impact.target.turnId}`}
                  onClick={() => onInspect(target.turnId, impact.path)}
                  type="button"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[10px] text-foreground/85">
                      {impact.path}
                    </span>
                    <span className="block truncate text-[9px] text-muted-foreground">
                      {impact.target.providerName} · turn {impact.target.checkpointTurnCount ?? "?"}
                    </span>
                  </span>
                  <span
                    className={
                      impact.kind === "remove"
                        ? "shrink-0 rounded-md bg-success/[0.08] px-1.5 py-0.5 text-[9px] text-success"
                        : impact.kind === "preserve"
                          ? "shrink-0 rounded-md bg-info/[0.08] px-1.5 py-0.5 text-[9px] text-info"
                          : "shrink-0 rounded-md bg-warning/[0.08] px-1.5 py-0.5 text-[9px] text-warning"
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
            <div className="text-[10px] leading-relaxed text-muted-foreground/75">
              {preview.canApply
                ? "Undo removes this turn's workspace patch while preserving conversation history and later non-overlapping work."
                : "Undo is paused until the overlapping changes are reviewed."}
            </div>
          </div>
        ) : null}
      </AlertDescription>
      <AlertAction className="w-full items-center justify-between gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {onOpenHistory ? (
            <Button size="xs" variant="ghost" onClick={onOpenHistory}>
              <HistoryIcon aria-hidden="true" />
              History
            </Button>
          ) : null}
          {firstPath ? (
            <Button size="xs" variant="ghost" onClick={() => onInspect(target.turnId, firstPath)}>
              Review diff
            </Button>
          ) : null}
          <Button disabled={!lineageComplete} size="xs" variant="ghost" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Hide details" : "Details"}
          </Button>
        </span>
        <span className="flex flex-wrap items-center gap-1">
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
        </span>
      </AlertAction>
    </Alert>
  );
});
