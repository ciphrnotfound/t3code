import type { ProvenanceFileMutation } from "@t3tools/client-runtime/state/provenance";

export type IntegrationCompatibility = "independent" | "ordered" | "review";

export type IntegrationAnalysis = {
  readonly compatibility: IntegrationCompatibility;
  readonly sharedPaths: ReadonlyArray<string>;
  readonly conflictPair?: {
    readonly candidate: ProvenanceFileMutation;
    readonly active: ProvenanceFileMutation;
    readonly lineRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  };
};

function intersectRanges(
  left: ProvenanceFileMutation["lineRanges"],
  right: ProvenanceFileMutation["lineRanges"],
) {
  if (!left?.length || !right?.length) return [];
  return left.flatMap((a) =>
    right.flatMap((b) => {
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      return start <= end ? [{ start, end }] : [];
    }),
  );
}

export function analyzeWorktreeIntegration(
  active: ReadonlyArray<ProvenanceFileMutation>,
  candidate: ReadonlyArray<ProvenanceFileMutation>,
): IntegrationAnalysis {
  const sharedPaths = [...new Set(active.map((item) => item.path))]
    .filter((path) => candidate.some((item) => item.path === path))
    .toSorted();
  if (sharedPaths.length === 0) return { compatibility: "independent", sharedPaths };

  for (const path of sharedPaths) {
    for (const activeMutation of active.filter((item) => item.path === path)) {
      for (const candidateMutation of candidate.filter((item) => item.path === path)) {
        const exactRanges = intersectRanges(activeMutation.lineRanges, candidateMutation.lineRanges);
        const uncertain = !activeMutation.lineRanges?.length || !candidateMutation.lineRanges?.length;
        if (uncertain || exactRanges.length > 0) {
          return {
            compatibility: "review",
            sharedPaths,
            conflictPair: {
              candidate: candidateMutation,
              active: activeMutation,
              lineRanges: exactRanges,
            },
          };
        }
      }
    }
  }
  return { compatibility: "ordered", sharedPaths };
}
