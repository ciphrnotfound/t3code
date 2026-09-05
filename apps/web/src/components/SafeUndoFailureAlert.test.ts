import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findLatestUnresolvedSafeUndoFailure } from "./SafeUndoFailureAlert";

const activity = (kind: string, payload: Record<string, unknown>): OrchestrationThreadActivity =>
  ({
    id: `activity-${kind}`,
    kind,
    tone: "info",
    summary: kind,
    payload,
    turnId: null,
    createdAt: "2026-09-03T00:00:00.000Z",
  }) as OrchestrationThreadActivity;

describe("safe undo recovery alert", () => {
  it("returns the latest unresolved safe undo failure", () => {
    const failure = activity("checkpoint.revert.failed", {
      turnCount: 3,
      detail: "Safe undo could not be applied cleanly.",
    });

    expect(findLatestUnresolvedSafeUndoFailure([failure])).toBe(failure);
  });

  it("clears a failure after the same turn is safely undone", () => {
    expect(
      findLatestUnresolvedSafeUndoFailure([
        activity("checkpoint.revert.failed", { turnCount: 3 }),
        activity("provenance.turn.reverted", { turnCount: 3 }),
      ]),
    ).toBeUndefined();
  });

  it("keeps a failure visible when another turn succeeds", () => {
    const failure = activity("checkpoint.revert.failed", { turnCount: 3 });

    expect(
      findLatestUnresolvedSafeUndoFailure([
        failure,
        activity("provenance.turn.reverted", { turnCount: 4 }),
      ]),
    ).toBe(failure);
  });
});
