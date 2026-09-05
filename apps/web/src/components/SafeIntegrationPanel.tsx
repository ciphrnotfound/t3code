import {
  readProvenanceTurnChangeSets,
  type ProvenanceFileMutation,
} from "@t3tools/client-runtime/state/provenance";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationThreadActivity,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { CheckCircle2Icon, GitMergeIcon, ShieldAlertIcon, WaypointsIcon } from "lucide-react";
import { useMemo } from "react";

import type { ConflictReviewTurn } from "~/diffPanelStore";
import { analyzeWorktreeIntegration } from "~/lib/safeIntegration";
import { useEnvironmentThreadRefs, useThread } from "~/state/entities";
import { Button } from "./ui/button";
import { cn } from "~/lib/utils";

type CompareInput = {
  readonly filePath: string;
  readonly lineRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  readonly earlier: ConflictReviewTurn;
  readonly current: ConflictReviewTurn;
};

function CandidateRow({
  threadRef,
  activeThreadId,
  activeProjectId,
  activeMutations,
  onCompare,
}: {
  readonly threadRef: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  readonly activeThreadId: ThreadId;
  readonly activeProjectId: ProjectId;
  readonly activeMutations: ReadonlyArray<ProvenanceFileMutation>;
  readonly onCompare: (input: CompareInput) => void;
}) {
  const thread = useThread(scopeThreadRef(threadRef.environmentId, threadRef.threadId), {
    waitForShell: true,
  });
  const candidateChangeSets = useMemo(
    () =>
      thread
        ? readProvenanceTurnChangeSets(thread.activities).filter(
            (changeSet) => changeSet.status === "completed",
          )
        : [],
    [thread],
  );
  const candidateMutations = useMemo(
    () => candidateChangeSets.flatMap((changeSet) => changeSet.mutations),
    [candidateChangeSets],
  );
  const analysis = useMemo(
    () => analyzeWorktreeIntegration(activeMutations, candidateMutations),
    [activeMutations, candidateMutations],
  );
  if (
    !thread ||
    thread.id === activeThreadId ||
    thread.projectId !== activeProjectId ||
    thread.worktreePath === null ||
    candidateMutations.length === 0
  ) {
    return null;
  }

  const pair = analysis.conflictPair;
  const candidateSet = pair
    ? candidateChangeSets.find((changeSet) => changeSet.turnId === pair.candidate.turnId)
    : undefined;
  const activeIsCurrent = pair ? pair.candidate.completedAt <= pair.active.completedAt : false;
  const status =
    analysis.compatibility === "independent"
      ? { label: "Independent", icon: CheckCircle2Icon, tone: "text-success bg-success/8" }
      : analysis.compatibility === "ordered"
        ? { label: "Sequence", icon: WaypointsIcon, tone: "text-info bg-info/8" }
        : { label: "Review", icon: ShieldAlertIcon, tone: "text-warning bg-warning/8" };
  const StatusIcon = status.icon;

  return (
    <article className="rounded-xl border border-border/55 bg-muted/[0.12] p-3">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg",
            status.tone,
          )}
        >
          <StatusIcon className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-medium">{thread.title}</span>
            <span
              className={cn(
                "ml-auto shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium",
                status.tone,
              )}
            >
              {status.label}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {thread.branch ?? "detached"} · {candidateMutations.length} recorded change
            {candidateMutations.length === 1 ? "" : "s"}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {analysis.compatibility === "independent"
              ? "No shared files. This worktree can be integrated independently."
              : analysis.compatibility === "ordered"
                ? `${analysis.sharedPaths.length} shared file${analysis.sharedPaths.length === 1 ? "" : "s"}, but recorded line ranges are disjoint. Integrate in sequence.`
                : `${analysis.sharedPaths.length} shared file${analysis.sharedPaths.length === 1 ? "" : "s"} needs ownership review before integration.`}
          </p>
          {analysis.sharedPaths.length > 0 ? (
            <div className="mt-1.5 truncate font-mono text-[10px] text-foreground/65">
              {analysis.sharedPaths.slice(0, 3).join(" · ")}
              {analysis.sharedPaths.length > 3 ? ` +${analysis.sharedPaths.length - 3}` : ""}
            </div>
          ) : null}
        </div>
      </div>
      {pair && candidateSet && activeIsCurrent ? (
        <div className="mt-2 flex justify-end border-t border-border/40 pt-2">
          <Button
            size="xs"
            variant="secondary"
            onClick={() =>
              onCompare({
                filePath: pair.active.path,
                lineRanges: pair.lineRanges,
                earlier: {
                  threadId: pair.candidate.threadId,
                  turnId: pair.candidate.turnId,
                  checkpointTurnCount: candidateSet.checkpointTurnCount ?? null,
                  providerName: pair.candidate.providerName,
                  action: pair.candidate.action,
                },
                current: {
                  threadId: pair.active.threadId,
                  turnId: pair.active.turnId,
                  checkpointTurnCount: pair.active.checkpointTurnCount ?? null,
                  providerName: pair.active.providerName,
                  action: pair.active.action,
                },
              })
            }
          >
            Review overlap
          </Button>
        </div>
      ) : null}
    </article>
  );
}

export function SafeIntegrationPanel({
  environmentId,
  projectId,
  activeThreadId,
  activeActivities,
  onCompare,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly activeThreadId: ThreadId;
  readonly activeActivities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly onCompare: (input: CompareInput) => void;
}) {
  const refs = useEnvironmentThreadRefs(environmentId);
  const activeMutations = useMemo(
    () =>
      readProvenanceTurnChangeSets(activeActivities)
        .filter((changeSet) => changeSet.status === "completed")
        .flatMap((changeSet) => changeSet.mutations),
    [activeActivities],
  );

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Integration Check">
      <header className="shrink-0 border-b border-border/60 px-3 py-3">
        <div className="flex items-center gap-2">
          <GitMergeIcon className="size-4 text-info" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-medium">Integration Check</h2>
            <p className="text-[11px] text-muted-foreground">
              Compare this task with recorded project worktrees.
            </p>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5 [scrollbar-width:thin]">
        {activeMutations.length === 0 ? (
          <div className="flex h-40 items-center justify-center px-6 text-center text-xs text-muted-foreground">
            This task needs a recorded file-changing turn before integration can be analyzed.
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-border/45 bg-muted/[0.08] px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
              Only dedicated worktrees with recorded changes appear here. T3 never treats missing
              history as safe to integrate.
            </div>
            {refs.map((ref) => (
              <CandidateRow
                key={`${ref.environmentId}:${ref.threadId}`}
                threadRef={ref}
                activeThreadId={activeThreadId}
                activeProjectId={projectId}
                activeMutations={activeMutations}
                onCompare={onCompare}
              />
            ))}
          </>
        )}
      </div>
    </section>
  );
}
