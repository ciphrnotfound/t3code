import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { shouldAppendRevertFailure } from "./FailureDedup.ts";

function failure(turnCount: number, detail: string): OrchestrationThreadActivity {
  return {
    id: `failure-${turnCount}` as never,
    tone: "error",
    kind: "checkpoint.revert.failed",
    summary: "Checkpoint revert failed",
    payload: { turnCount, detail },
    turnId: null,
    createdAt: "2026-09-03T09:00:00.000Z",
  };
}

describe("shouldAppendRevertFailure", () => {
  it("suppresses an identical latest failure", () => {
    expect(
      shouldAppendRevertFailure([failure(3, "Workspace conflict")], {
        turnCount: 3,
        detail: "Workspace conflict",
      }),
    ).toBe(false);
  });

  it("keeps different turns and changed failure reasons visible", () => {
    const activities = [failure(3, "Workspace conflict")];
    expect(shouldAppendRevertFailure(activities, { turnCount: 4, detail: "Workspace conflict" }))
      .toBe(true);
    expect(shouldAppendRevertFailure(activities, { turnCount: 3, detail: "Missing patch" }))
      .toBe(true);
  });

  it("fails open for malformed historical payloads", () => {
    expect(
      shouldAppendRevertFailure([{ ...failure(3, "Workspace conflict"), payload: null }], {
        turnCount: 3,
        detail: "Workspace conflict",
      }),
    ).toBe(true);
  });
});
