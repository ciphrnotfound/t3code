import { describe, expect, it } from "vite-plus/test";
import type { CheckpointRef, ThreadId, TurnId } from "@t3tools/contracts";

import {
  buildProvenanceTurnChangeSets,
  buildSafeUndoPreview,
  canAttemptSafeUndo,
  describeProvenanceTurnScope,
  findProvenanceFileOverlaps,
  findProvenanceLineOwner,
  readProvenanceTurnChangeSets,
  type ProvenanceFileMutation,
  type ProvenanceTurnChangeSet,
} from "./provenance.ts";

function mutation(overrides: Partial<ProvenanceFileMutation> = {}): ProvenanceFileMutation {
  return {
    workspaceKey: "project:billing",
    threadId: "thread-a" as ThreadId,
    turnId: "turn-a" as TurnId,
    checkpointRef: "refs/t3/a" as CheckpointRef,
    completedAt: "2026-08-31T10:00:00.000Z",
    providerName: "codex",
    operation: "modified",
    action: "apply_patch",
    path: "src/auth/session.ts",
    ...overrides,
  };
}

function changeSet(overrides: Partial<ProvenanceTurnChangeSet> = {}): ProvenanceTurnChangeSet {
  const base = mutation();
  return {
    workspaceKey: base.workspaceKey,
    threadId: base.threadId,
    turnId: base.turnId,
    checkpointRef: base.checkpointRef,
    completedAt: base.completedAt,
    providerName: base.providerName,
    mutations: [base],
    status: "completed",
    ...overrides,
  };
}

describe("findProvenanceLineOwner", () => {
  it("returns the newest recorded range and supports file-only fallback", () => {
    const older = mutation({
      path: "src/app.ts",
      completedAt: "2026-01-01T00:00:00.000Z",
      lineRanges: [{ start: 10, end: 20 }],
    });
    const newer = mutation({
      path: "src/app.ts",
      completedAt: "2026-01-02T00:00:00.000Z",
      lineRanges: [{ start: 15, end: 18 }],
    });
    expect(findProvenanceLineOwner([older, newer], "src/app.ts", 16)).toEqual({
      mutation: newer,
      confidence: "recorded-range",
    });
    expect(findProvenanceLineOwner([older, newer], "src/app.ts", 30)).toBeUndefined();
    expect(
      findProvenanceLineOwner([mutation({ path: "src/app.ts" })], "src/app.ts", 30)?.confidence,
    ).toBe("file-only");
  });
});

describe("describeProvenanceTurnScope", () => {
  it("confirms when every changed file is explicitly named in the request", () => {
    const target = changeSet({
      mutations: [mutation({ path: "src/auth.ts" }), mutation({ path: "src/billing.ts" })],
    });
    expect(
      describeProvenanceTurnScope(
        target,
        "Update src/auth.ts and src/billing.ts only. Do not modify other files.",
      ),
    ).toEqual({ requestedPaths: ["src/auth.ts", "src/billing.ts"], unrequestedPaths: [] });
  });

  it("flags only changed files that were not explicitly named", () => {
    const target = changeSet({
      mutations: [mutation({ path: "src/auth.ts" }), mutation({ path: "src/billing.ts" })],
    });
    expect(describeProvenanceTurnScope(target, "Only change src/auth.ts.")).toEqual({
      requestedPaths: ["src/auth.ts"],
      unrequestedPaths: ["src/billing.ts"],
    });
  });

  it("stays silent when a request does not name a file", () => {
    expect(
      describeProvenanceTurnScope(changeSet(), "Make the sign-in flow more robust."),
    ).toBeUndefined();
  });
});

describe("safe undo boundaries", () => {
  it("does not offer an already reverted turn again", () => {
    const target = mutation();
    const preview = buildSafeUndoPreview(changeSet({ mutations: [target], status: "reverted" }), [
      target,
    ]);
    expect(preview.canApply).toBe(false);
  });

  it("requires review for rename mutations", () => {
    const target = mutation({ operation: "renamed" });
    const preview = buildSafeUndoPreview(changeSet({ mutations: [target] }), [target]);
    expect(preview.canApply).toBe(false);
    expect(preview.conflicts[0]?.reason).toBe("lineage-uncertain");
  });

  it("requires review for explicitly unsupported mutations", () => {
    const target = mutation({ undoable: false });
    const preview = buildSafeUndoPreview(changeSet({ mutations: [target] }), [target]);
    expect(preview.canApply).toBe(false);
    expect(preview.conflicts[0]?.reason).toBe("lineage-uncertain");
  });
});

describe("findProvenanceFileOverlaps", () => {
  it("reports different threads that touch the same file in one workspace", () => {
    const overlaps = findProvenanceFileOverlaps([
      mutation(),
      mutation({
        threadId: "thread-b" as ThreadId,
        turnId: "turn-b" as TurnId,
        checkpointRef: "refs/t3/b" as CheckpointRef,
        completedAt: "2026-08-31T10:01:00.000Z",
      }),
    ]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({
      path: "src/auth/session.ts",
      earlier: { threadId: "thread-a" as ThreadId },
      later: { threadId: "thread-b" as ThreadId },
    });
  });

  it("ignores repeated changes by one thread and changes in other workspaces", () => {
    expect(
      findProvenanceFileOverlaps([
        mutation(),
        mutation({
          turnId: "turn-a-2" as TurnId,
          checkpointRef: "refs/t3/a-2" as CheckpointRef,
          completedAt: "2026-08-31T10:01:00.000Z",
        }),
        mutation({
          workspaceKey: "project:other",
          threadId: "thread-b" as ThreadId,
          turnId: "turn-b" as TurnId,
          checkpointRef: "refs/t3/b" as CheckpointRef,
          completedAt: "2026-08-31T10:02:00.000Z",
        }),
      ]),
    ).toEqual([]);
  });

  it("keeps provider identity as data rather than restricting overlap detection", () => {
    const overlaps = findProvenanceFileOverlaps([
      mutation({ providerName: "claude" }),
      mutation({
        providerName: "opencode",
        threadId: "thread-b" as ThreadId,
        turnId: "turn-b" as TurnId,
        checkpointRef: "refs/t3/b" as CheckpointRef,
        completedAt: "2026-08-31T10:01:00.000Z",
      }),
    ]);
    expect(overlaps[0]).toMatchObject({
      earlier: { providerName: "claude" },
      later: { providerName: "opencode" },
    });
  });
});

describe("buildProvenanceTurnChangeSets", () => {
  it("groups file mutations by workspace, thread, and turn", () => {
    const sets = buildProvenanceTurnChangeSets([
      mutation(),
      mutation({ path: "src/auth/middleware.ts" }),
      mutation({
        turnId: "turn-b" as TurnId,
        checkpointRef: "refs/t3/b" as CheckpointRef,
        completedAt: "2026-08-31T10:01:00.000Z",
      }),
    ]);
    expect(sets).toHaveLength(2);
    expect(sets[0]!.mutations).toHaveLength(2);
    expect(sets[1]!.turnId).toBe("turn-b");
  });
});

describe("readProvenanceTurnChangeSets", () => {
  it("bounds materialized history for long-lived threads", () => {
    const activities = Array.from({ length: 205 }, (_, index) => ({
      id: `event-${index}`,
      tone: "info",
      kind: "provenance.turn.completed",
      summary: "Agent turn change set recorded",
      turnId: `turn-${index}`,
      createdAt: `2026-08-31T10:${String(index).padStart(2, "0")}:00.000Z`,
      payload: {
        mutations: [
          mutation({
            turnId: `turn-${index}` as TurnId,
            completedAt: `2026-08-31T10:${String(index).padStart(2, "0")}:00.000Z`,
          }),
        ],
      },
    })) as never;
    const result = readProvenanceTurnChangeSets(activities);
    expect(result).toHaveLength(200);
  });

  it("treats malformed persisted line ranges as unknown ownership", () => {
    const result = readProvenanceTurnChangeSets([
      {
        id: "event-malformed-range",
        tone: "info",
        kind: "provenance.turn.completed",
        summary: "Agent turn change set recorded",
        turnId: "turn-a",
        createdAt: "2026-08-31T10:00:00.000Z",
        payload: {
          mutations: [mutation({ lineRanges: [{ start: 0, end: 12 }] })],
        },
      } as never,
    ]);
    expect(result[0]?.mutations[0]?.lineRanges).toBeUndefined();
  });

  it("keeps the durable pre-turn checkpoint for safe undo planning", () => {
    const result = readProvenanceTurnChangeSets([
      {
        id: "event-1",
        tone: "info",
        kind: "provenance.turn.completed",
        summary: "Agent turn change set recorded",
        turnId: "turn-a",
        createdAt: "2026-08-31T10:00:00.000Z",
        payload: {
          beforeCheckpointRef: "refs/t3/before-a",
          checkpointTurnCount: 3,
          mutations: [mutation()],
        },
      } as never,
    ]);
    expect(result[0]).toMatchObject({
      turnId: "turn-a",
      beforeCheckpointRef: "refs/t3/before-a",
      checkpointTurnCount: 3,
    });
  });

  it("surfaces the persisted no-extra-token turn description", () => {
    const result = readProvenanceTurnChangeSets([
      {
        id: "event-summary",
        tone: "info",
        kind: "provenance.turn.completed",
        summary: "Agent turn change set recorded",
        turnId: "turn-a",
        createdAt: "2026-08-31T10:00:00.000Z",
        payload: {
          turnSummary: "Updated authentication and preserved existing sessions.",
          mutations: [mutation()],
        },
      } as never,
    ]);
    expect(result[0]?.turnSummary).toBe("Updated authentication and preserved existing sessions.");
  });

  it("maps incomplete checkpoint records to a review-only status", () => {
    const result = readProvenanceTurnChangeSets([
      {
        id: "event-2",
        tone: "info",
        kind: "provenance.turn.completed",
        summary: "Agent turn change set recorded",
        turnId: "turn-a",
        createdAt: "2026-08-31T10:00:00.000Z",
        payload: { status: "missing", mutations: [mutation()] },
      } as never,
    ]);
    expect(result[0]?.status).toBe("interrupted");
  });

  it("marks a safely undone turn as reverted and exposes its verified receipt", () => {
    const patchSha256 = "a".repeat(64);
    const result = readProvenanceTurnChangeSets([
      {
        id: "event-completed",
        tone: "info",
        kind: "provenance.turn.completed",
        summary: "Agent turn change set recorded",
        turnId: "turn-a",
        createdAt: "2026-08-31T10:00:00.000Z",
        payload: { mutations: [mutation()] },
      } as never,
      {
        id: "event-reverted",
        tone: "info",
        kind: "provenance.turn.reverted",
        summary: "Safe undo applied",
        turnId: null,
        createdAt: "2026-08-31T10:01:00.000Z",
        payload: {
          turnId: "turn-a",
          turnCount: 1,
          undoReceipt: {
            version: 1,
            scope: "code-only",
            appliedAt: "2026-08-31T10:01:00.000Z",
            patchSha256,
            paths: ["src/auth/session.ts"],
          },
        },
      } as never,
    ]);
    expect(result[0]?.status).toBe("reverted");
    expect(result[0]?.undoReceipt).toEqual({
      version: 1,
      scope: "code-only",
      appliedAt: "2026-08-31T10:01:00.000Z",
      patchSha256,
      paths: ["src/auth/session.ts"],
    });
  });

  it("keeps a reverted turn but hides an invalid undo receipt", () => {
    const result = readProvenanceTurnChangeSets([
      {
        id: "event-completed-invalid-receipt",
        tone: "info",
        kind: "provenance.turn.completed",
        summary: "Agent turn change set recorded",
        turnId: "turn-a",
        createdAt: "2026-08-31T10:00:00.000Z",
        payload: { mutations: [mutation()] },
      } as never,
      {
        id: "event-reverted-invalid-receipt",
        tone: "info",
        kind: "provenance.turn.reverted",
        summary: "Safe undo applied",
        turnId: null,
        createdAt: "2026-08-31T10:01:00.000Z",
        payload: {
          turnId: "turn-a",
          turnCount: 1,
          undoReceipt: {
            version: 1,
            scope: "code-only",
            appliedAt: "not-a-timestamp",
            patchSha256: "a".repeat(64),
            paths: ["src/auth/session.ts"],
          },
        },
      } as never,
    ]);
    expect(result[0]?.status).toBe("reverted");
    expect(result[0]?.undoReceipt).toBeUndefined();
  });
});

describe("buildSafeUndoPreview", () => {
  it("marks a turn removable when later edits are disjoint", () => {
    const targetMutation = mutation({ lineRanges: [{ start: 10, end: 20 }] });
    const target = changeSet({ mutations: [targetMutation] });
    const later = mutation({
      threadId: "thread-b" as ThreadId,
      turnId: "turn-b" as TurnId,
      completedAt: "2026-08-31T10:01:00.000Z",
      lineRanges: [{ start: 40, end: 50 }],
    });
    const preview = buildSafeUndoPreview(target, [targetMutation, later]);
    expect(preview.canApply).toBe(true);
    expect(preview.removable).toHaveLength(1);
    expect(preview.conflicts).toEqual([]);
    expect(preview.preserved).toEqual([later]);
  });

  it("requires review when a later edit overlaps the target range", () => {
    const targetMutation = mutation({ lineRanges: [{ start: 10, end: 20 }] });
    const target = changeSet({ mutations: [targetMutation] });
    const later = mutation({
      threadId: "thread-b" as ThreadId,
      turnId: "turn-b" as TurnId,
      completedAt: "2026-08-31T10:01:00.000Z",
      lineRanges: [{ start: 18, end: 30 }],
    });
    const preview = buildSafeUndoPreview(target, [targetMutation, later]);
    expect(preview.canApply).toBe(false);
    expect(preview.removable).toEqual([]);
    expect(preview.conflicts[0]!).toMatchObject({
      path: targetMutation.path,
      reason: "later-overlap",
    });
    expect(canAttemptSafeUndo(preview)).toBe(true);
  });

  it("requires review when line ownership is unknown", () => {
    const targetMutation = mutation({ lineRanges: [{ start: 10, end: 20 }] });
    const target = changeSet({ mutations: [targetMutation] });
    const later = mutation({
      threadId: "thread-b" as ThreadId,
      turnId: "turn-b" as TurnId,
      completedAt: "2026-08-31T10:01:00.000Z",
    });
    const preview = buildSafeUndoPreview(target, [targetMutation, later]);
    expect(preview.canApply).toBe(false);
    expect(preview.conflicts[0]!.reason).toBe("lineage-uncertain");
    expect(canAttemptSafeUndo(preview)).toBe(false);
  });
});
