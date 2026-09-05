import type { MessageId, OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";
import {
  buildSafeUndoPreview,
  canAttemptSafeUndo,
  describeProvenanceTurnScope,
  readProvenanceTurnChangeSets,
} from "@t3tools/client-runtime/state/provenance";
import {
  BellOffIcon,
  BellRingIcon,
  FileDiffIcon,
  FingerprintIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "./ui/button";
import { cn } from "~/lib/utils";

type StatusFilter = "all" | "ready" | "review" | "undone";

export function SafeHistoryPanel({
  alertsHidden,
  activities,
  assistantMessageIdByTurnId,
  userRequestByTurnId,
  onInspect,
  onAlertsHiddenChange,
  onRevealConversation,
  onPreviewUndo,
  onUndoTurn,
}: {
  alertsHidden: boolean;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  assistantMessageIdByTurnId: ReadonlyMap<TurnId, MessageId>;
  userRequestByTurnId: ReadonlyMap<TurnId, string>;
  onInspect: (turnId: TurnId, filePath?: string) => void;
  onAlertsHiddenChange: (hidden: boolean) => void;
  onRevealConversation: (messageId: MessageId) => void;
  onPreviewUndo: (turnCount: number) => boolean | void | Promise<boolean | void>;
  onUndoTurn: (turnCount: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [previewingTurnCount, setPreviewingTurnCount] = useState<number | null>(null);
  const [previewedTurnCounts, setPreviewedTurnCounts] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const changeSets = useMemo(() => readProvenanceTurnChangeSets(activities), [activities]);
  const allMutations = useMemo(
    () => changeSets.flatMap((changeSet) => changeSet.mutations),
    [changeSets],
  );
  const rows = useMemo(
    () =>
      changeSets
        .toReversed()
        .map((changeSet) => ({
          changeSet,
          preview: buildSafeUndoPreview(changeSet, allMutations),
        }))
        .filter(({ changeSet, preview }) => {
          const statusMatches =
            filter === "all" ||
            (filter === "undone" && changeSet.status === "reverted") ||
            (filter === "ready" && changeSet.status === "completed" && preview.canApply) ||
            (filter === "review" && changeSet.status !== "reverted" && !preview.canApply);
          if (!statusMatches) return false;
          const needle = query.trim().toLowerCase();
          return (
            needle.length === 0 ||
            changeSet.providerName.toLowerCase().includes(needle) ||
            changeSet.turnSummary?.toLowerCase().includes(needle) ||
            changeSet.mutations.some((mutation) => mutation.path.toLowerCase().includes(needle))
          );
        }),
    [allMutations, changeSets, filter, query],
  );

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Provenance">
      <header className="shrink-0 border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <FingerprintIcon className="size-4 text-info" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">Provenance</h2>
            <p className="text-[11px] text-muted-foreground">
              {changeSets.length} attributed turns
            </p>
          </div>
          <Button
            aria-label={
              alertsHidden ? "Resume provenance alerts" : "Stop showing provenance alerts"
            }
            size="xs"
            variant="ghost"
            onClick={() => onAlertsHiddenChange(!alertsHidden)}
          >
            {alertsHidden ? (
              <BellRingIcon aria-hidden="true" />
            ) : (
              <BellOffIcon aria-hidden="true" />
            )}
            {alertsHidden ? "Resume alerts" : "Mute alerts"}
          </Button>
        </div>
        <label className="mt-2.5 flex h-8 items-center gap-2 rounded-lg border border-border/55 bg-muted/15 px-2.5 transition-colors focus-within:border-ring">
          <SearchIcon className="size-3.5 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files, agents, or summaries"
            value={query}
          />
        </label>
        <div className="mt-2 flex gap-1">
          {(["all", "ready", "review", "undone"] as const).map((value) => (
            <button
              className={cn(
                "rounded-md px-2 py-1 text-[10px] capitalize text-muted-foreground transition-colors hover:text-foreground",
                filter === value && "bg-muted/80 text-foreground",
              )}
              key={value}
              onClick={() => setFilter(value)}
              type="button"
            >
              {value}
            </button>
          ))}
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5 [scrollbar-width:thin]">
        {rows.length === 0 ? (
          <div className="flex h-40 items-center justify-center px-6 text-center text-xs text-muted-foreground">
            {changeSets.length === 0
              ? "File-changing turns will appear here automatically."
              : "No recorded turns match this search."}
          </div>
        ) : (
          rows.map(({ changeSet, preview }) => {
            const firstPath = changeSet.mutations[0]?.path;
            const messageId = assistantMessageIdByTurnId.get(changeSet.turnId);
            const scope = describeProvenanceTurnScope(
              changeSet,
              userRequestByTurnId.get(changeSet.turnId),
            );
            const unrequestedFileCount = scope?.unrequestedPaths.length ?? 0;
            const checkpointTurnCount = changeSet.checkpointTurnCount;
            const canUndo =
              changeSet.status === "completed" &&
              canAttemptSafeUndo(preview) &&
              checkpointTurnCount !== undefined;
            const needsReview =
              changeSet.status === "completed" &&
              !preview.canApply &&
              checkpointTurnCount !== undefined;
            const hasRecoveryPreview =
              (checkpointTurnCount !== undefined && previewedTurnCounts.has(checkpointTurnCount)) ||
              activities.toReversed().some((activity) => {
                if (activity.kind !== "provenance.turn.undo.previewed") return false;
                const payload = activity.payload as { readonly turnCount?: unknown };
                return payload.turnCount === checkpointTurnCount;
              });
            const isPreviewingRecovery = previewingTurnCount === checkpointTurnCount;
            return (
              <article
                className="rounded-lg border border-border/45 bg-muted/[0.055] p-2.5 transition-colors hover:bg-muted/[0.09]"
                key={changeSet.turnId}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">
                      {changeSet.providerName} · turn {changeSet.checkpointTurnCount ?? "?"}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {changeSet.mutations.length} file
                      {changeSet.mutations.length === 1 ? "" : "s"} · {changeSet.status}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium",
                      changeSet.status === "reverted"
                        ? "bg-muted text-muted-foreground"
                        : preview.canApply
                          ? "bg-success/10 text-success"
                          : canUndo
                            ? "bg-info/10 text-info"
                            : "bg-warning/10 text-warning",
                    )}
                  >
                    {changeSet.status === "reverted"
                      ? "Undone"
                      : preview.canApply
                        ? "Ready"
                        : canUndo
                          ? "Check"
                          : "Review"}
                  </span>
                </div>
                {changeSet.turnSummary ? (
                  <p className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-foreground/75">
                    {changeSet.turnSummary}
                  </p>
                ) : null}
                {scope ? (
                  <div className="mt-1.5 flex min-w-0 items-center gap-1.5 rounded-md bg-foreground/[0.035] px-2 py-1 text-[10px]">
                    {unrequestedFileCount === 0 ? (
                      <ShieldCheckIcon
                        className="size-3 shrink-0 text-success"
                        aria-hidden="true"
                      />
                    ) : (
                      <ShieldAlertIcon
                        className="size-3 shrink-0 text-warning"
                        aria-hidden="true"
                      />
                    )}
                    <span className="font-medium text-foreground/80">Scope</span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {unrequestedFileCount === 0
                        ? "All changed files were named in the request"
                        : `${unrequestedFileCount} ${unrequestedFileCount === 1 ? "file was" : "files were"} not named in the request`}
                    </span>
                  </div>
                ) : null}
                {changeSet.undoReceipt ? (
                  <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span className="shrink-0">Undo receipt</span>
                    <code className="truncate font-mono text-foreground/70">
                      {changeSet.undoReceipt.patchSha256.slice(0, 12)}
                    </code>
                    <span aria-hidden="true">·</span>
                    <span className="shrink-0">
                      {changeSet.undoReceipt.paths.length} file
                      {changeSet.undoReceipt.paths.length === 1 ? "" : "s"}
                    </span>
                  </div>
                ) : null}
                {hasRecoveryPreview && changeSet.status !== "reverted" ? (
                  <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-md border border-success/20 bg-success/8 px-2 py-1.5 text-[10px]">
                    <ShieldCheckIcon className="size-3 shrink-0 text-success" aria-hidden="true" />
                    <span className="font-medium text-success">Recovery check passed</span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      Workspace unchanged
                    </span>
                  </div>
                ) : null}
                <div className="mt-1.5 space-y-0.5">
                  {changeSet.mutations.slice(0, 3).map((mutation) => (
                    <button
                      className="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-[10px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      key={mutation.path}
                      onClick={() => onInspect(changeSet.turnId, mutation.path)}
                      type="button"
                    >
                      {mutation.previousPath ? `${mutation.previousPath} → ` : ""}
                      {mutation.path}
                    </button>
                  ))}
                </div>
                <div className="mt-1.5 flex flex-wrap justify-end gap-1 border-t border-border/35 pt-1.5">
                  {messageId ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => onRevealConversation(messageId)}
                    >
                      <MessageSquareTextIcon /> Conversation
                    </Button>
                  ) : null}
                  {firstPath ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => onInspect(changeSet.turnId, firstPath)}
                    >
                      <FileDiffIcon /> Review
                    </Button>
                  ) : null}
                  {canUndo && checkpointTurnCount !== undefined ? (
                    !hasRecoveryPreview ? (
                      <Button
                        disabled={isPreviewingRecovery}
                        size="xs"
                        variant="secondary"
                        onClick={async () => {
                          setPreviewingTurnCount(checkpointTurnCount);
                          try {
                            const succeeded = await onPreviewUndo(checkpointTurnCount);
                            if (succeeded !== false) {
                              setPreviewedTurnCounts((current) =>
                                new Set(current).add(checkpointTurnCount),
                              );
                            }
                          } finally {
                            setPreviewingTurnCount(null);
                          }
                        }}
                      >
                        {isPreviewingRecovery ? (
                          <>
                            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                            Checking…
                          </>
                        ) : (
                          "Preview"
                        )}
                      </Button>
                    ) : null
                  ) : null}
                  {canUndo && checkpointTurnCount !== undefined ? (
                    <Button
                      size="xs"
                      variant="destructive"
                      onClick={() => onUndoTurn(checkpointTurnCount)}
                    >
                      {hasRecoveryPreview
                        ? "Apply undo"
                        : preview.canApply
                          ? "Undo"
                          : "Check & undo"}
                    </Button>
                  ) : needsReview && firstPath ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => onInspect(changeSet.turnId, firstPath)}
                    >
                      Review
                    </Button>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
