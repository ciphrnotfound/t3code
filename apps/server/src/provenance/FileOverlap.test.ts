import { describe, expect, it } from "vite-plus/test";
import type { CheckpointRef, ThreadId, TurnId } from "@t3tools/contracts";

import { findFileOverlaps, type ProvenanceMutation } from "./FileOverlap.ts";

function mutation(overrides: Partial<ProvenanceMutation> = {}): ProvenanceMutation {
  return {
    workspaceKey: "C:/repo",
    threadId: "thread-a" as ThreadId,
    turnId: "turn-a" as TurnId,
    checkpointTurnCount: 1,
    checkpointRef: "refs/t3/a" as CheckpointRef,
    completedAt: "2026-09-01T10:00:00.000Z",
    providerName: "claude",
    operation: "modified",
    action: "apply_patch",
    path: "src/auth/session.ts",
    ...overrides,
  };
}

describe("findFileOverlaps", () => {
  it("detects a file changed by another thread in the same checkout", () => {
    const overlaps = findFileOverlaps([
      mutation(),
      mutation({
        threadId: "thread-b" as ThreadId,
        turnId: "turn-b" as TurnId,
        checkpointRef: "refs/t3/b" as CheckpointRef,
        completedAt: "2026-09-01T10:01:00.000Z",
      }),
    ]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.earlier.threadId).toBe("thread-a" as ThreadId);
    expect(overlaps[0]?.later.threadId).toBe("thread-b" as ThreadId);
  });

  it("ignores same-thread edits and separate workspaces", () => {
    expect(
      findFileOverlaps([
        mutation(),
        mutation({
          turnId: "turn-a-2" as TurnId,
          checkpointRef: "refs/t3/a-2" as CheckpointRef,
          completedAt: "2026-09-01T10:01:00.000Z",
        }),
        mutation({
          workspaceKey: "C:/other",
          threadId: "thread-b" as ThreadId,
          turnId: "turn-b" as TurnId,
          checkpointRef: "refs/t3/b" as CheckpointRef,
          completedAt: "2026-09-01T10:02:00.000Z",
        }),
      ]),
    ).toEqual([]);
  });

  it("follows a file across a rename boundary", () => {
    const overlaps = findFileOverlaps([
      mutation({ path: "src/old.ts" }),
      mutation({
        threadId: "thread-b" as ThreadId,
        turnId: "turn-b" as TurnId,
        checkpointRef: "refs/t3/b" as CheckpointRef,
        completedAt: "2026-09-01T10:01:00.000Z",
        operation: "renamed",
        path: "src/new.ts",
        previousPath: "src/old.ts",
      }),
    ]);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({
      path: "src/new.ts",
      earlier: { path: "src/old.ts" },
      later: { path: "src/new.ts", previousPath: "src/old.ts" },
    });
  });

  it("keeps following edits made to the renamed destination", () => {
    const overlaps = findFileOverlaps([
      mutation({
        operation: "renamed",
        path: "src/new.ts",
        previousPath: "src/old.ts",
      }),
      mutation({
        threadId: "thread-b" as ThreadId,
        turnId: "turn-b" as TurnId,
        checkpointRef: "refs/t3/b" as CheckpointRef,
        completedAt: "2026-09-01T10:01:00.000Z",
        path: "src/new.ts",
      }),
    ]);

    expect(overlaps).toHaveLength(1);
  });
});

describe("range-aware overlap behavior", () => {
  it.each(["thread-b", "thread-c"])(
    "retains older regions after a disjoint edit by %s",
    (middleThread) => {
      const overlaps = findFileOverlaps([
        mutation({ lineRanges: [{ start: 10, end: 20 }] }),
        mutation({
          threadId: middleThread as ThreadId,
          turnId: "middle" as TurnId,
          completedAt: "2026-09-01T10:01:00.000Z",
          lineRanges: [{ start: 30, end: 40 }],
        }),
        mutation({
          threadId: "thread-c" as ThreadId,
          turnId: "last" as TurnId,
          completedAt: "2026-09-01T10:02:00.000Z",
          lineRanges: [{ start: 12, end: 15 }],
        }),
      ]);
      expect(overlaps).toHaveLength(1);
      expect(overlaps[0]).toMatchObject({
        earlier: { threadId: "thread-a" },
        later: { turnId: "last" },
        lineRanges: [{ start: 12, end: 15 }],
      });
    },
  );

  it("selects the newest matching owner without duplicating rename alerts", () => {
    const overlaps = findFileOverlaps([
      mutation({ lineRanges: [{ start: 10, end: 20 }] }),
      mutation({
        threadId: "thread-b" as ThreadId,
        turnId: "middle" as TurnId,
        completedAt: "2026-09-01T10:01:00.000Z",
        lineRanges: [{ start: 12, end: 15 }],
      }),
      mutation({
        threadId: "thread-c" as ThreadId,
        turnId: "last" as TurnId,
        completedAt: "2026-09-01T10:02:00.000Z",
        operation: "renamed",
        previousPath: "src/auth/session.ts",
        path: "src/auth/renamed.ts",
      }),
    ]);
    expect(overlaps).toHaveLength(2);
    expect(overlaps[1]).toMatchObject({ earlier: { turnId: "middle" }, later: { turnId: "last" } });
  });

  it("ignores disjoint ranges and reports shared ranges", () => {
    const disjoint = findFileOverlaps([
      mutation({ lineRanges: [{ start: 10, end: 20 }] }),
      mutation({
        threadId: "thread-b" as ThreadId,
        turnId: "turn-b" as TurnId,
        completedAt: "2026-09-01T10:01:00.000Z",
        lineRanges: [{ start: 30, end: 40 }],
      }),
    ]);
    expect(disjoint).toEqual([]);

    const shared = findFileOverlaps([
      mutation({ lineRanges: [{ start: 10, end: 20 }] }),
      mutation({
        threadId: "thread-b" as ThreadId,
        turnId: "turn-b" as TurnId,
        completedAt: "2026-09-01T10:01:00.000Z",
        lineRanges: [{ start: 18, end: 25 }],
      }),
    ]);
    expect(shared[0]?.lineRanges).toEqual([{ start: 18, end: 20 }]);
  });
});
