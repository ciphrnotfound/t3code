import type { ProvenanceFileMutation } from "@t3tools/client-runtime/state/provenance";
import { CheckpointRef, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { analyzeWorktreeIntegration } from "./safeIntegration";

const mutation = (
  path: string,
  lineRanges?: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): ProvenanceFileMutation => ({
  workspaceKey: "workspace",
  threadId: ThreadId.make(`thread-${path}`),
  turnId: TurnId.make(`turn-${path}`),
  checkpointRef: CheckpointRef.make(`checkpoint-${path}`),
  completedAt: "2026-09-03T00:00:00.000Z",
  providerName: "codex",
  operation: "modified",
  action: "File change",
  path,
  ...(lineRanges ? { lineRanges } : {}),
});

describe("safe worktree integration", () => {
  it("marks different files as independently integrable", () => {
    expect(analyzeWorktreeIntegration([mutation("a.ts")], [mutation("b.ts")])).toEqual({
      compatibility: "independent",
      sharedPaths: [],
    });
  });

  it("orders same-file changes when exact ranges are disjoint", () => {
    expect(
      analyzeWorktreeIntegration(
        [mutation("a.ts", [{ start: 1, end: 4 }])],
        [mutation("a.ts", [{ start: 20, end: 24 }])],
      ).compatibility,
    ).toBe("ordered");
  });

  it("requires review for intersecting or uncertain ownership", () => {
    expect(
      analyzeWorktreeIntegration(
        [mutation("a.ts", [{ start: 1, end: 8 }])],
        [mutation("a.ts", [{ start: 6, end: 10 }])],
      ),
    ).toMatchObject({ compatibility: "review", conflictPair: { lineRanges: [{ start: 6, end: 8 }] } });
    expect(analyzeWorktreeIntegration([mutation("a.ts")], [mutation("a.ts")]).compatibility).toBe(
      "review",
    );
  });
});
