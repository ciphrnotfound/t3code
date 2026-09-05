import { describe, expect, it } from "vite-plus/test";

import { readPersistedProvenanceHistory } from "./PersistedHistory.ts";
import { findFileOverlaps } from "./FileOverlap.ts";

function completed(turnId: string, completedAt: string, workspaceKey = "C:/repo") {
  return {
    kind: "provenance.turn.completed",
    payload: {
      mutations: [
        {
          workspaceKey,
          threadId: `thread-${turnId}`,
          turnId,
          checkpointTurnCount: 1,
          checkpointRef: `refs/t3/${turnId}`,
          completedAt,
          providerName: "codex",
          operation: "modified",
          action: "File change",
          path: "src/app.ts",
          lineRanges: [{ start: 4, end: 8 }],
        },
      ],
    },
  };
}

describe("readPersistedProvenanceHistory", () => {
  it("finds an older overlapping region after rebuilding persisted history", () => {
    const first = completed("first", "2026-09-01T10:00:00.000Z");
    const middle = completed("middle", "2026-09-01T10:01:00.000Z");
    middle.payload.mutations[0]!.lineRanges = [{ start: 30, end: 40 }];
    const last = completed("last", "2026-09-01T10:02:00.000Z");
    const history = readPersistedProvenanceHistory(
      [{ activities: [last] }, { activities: [middle] }, { activities: [first] }],
      "C:/repo",
    );
    expect(findFileOverlaps(history)).toMatchObject([
      {
        earlier: { turnId: "first" },
        later: { turnId: "last" },
        lineRanges: [{ start: 4, end: 8 }],
      },
    ]);
  });

  it("rebuilds workspace history in completion order and excludes reverted turns", () => {
    const history = readPersistedProvenanceHistory(
      [
        {
          activities: [
            completed("turn-later", "2026-09-01T10:02:00.000Z"),
            completed("turn-reverted", "2026-09-01T10:01:00.000Z"),
            {
              kind: "provenance.turn.reverted",
              payload: { turnId: "turn-reverted" },
            },
          ],
        },
        { activities: [completed("turn-earlier", "2026-09-01T10:00:00.000Z")] },
      ],
      "C:/repo",
    );

    expect(history.map((mutation) => mutation.turnId)).toEqual(["turn-earlier", "turn-later"]);
  });

  it("ignores other workspaces and malformed activity payloads", () => {
    const history = readPersistedProvenanceHistory(
      [
        {
          activities: [
            completed("turn-other", "2026-09-01T10:00:00.000Z", "C:/other"),
            { kind: "provenance.turn.completed", payload: { mutations: [{ nope: true }] } },
          ],
        },
      ],
      "C:/repo",
    );

    expect(history).toEqual([]);
  });

  it("drops malformed line ranges instead of claiming exact ownership", () => {
    const history = readPersistedProvenanceHistory(
      [
        {
          activities: [
            {
              ...completed("turn-invalid-range", "2026-09-01T10:00:00.000Z"),
              payload: {
                mutations: [
                  {
                    ...completed("turn-invalid-range", "2026-09-01T10:00:00.000Z").payload
                      .mutations[0],
                    lineRanges: [{ start: 0, end: 4 }],
                  },
                ],
              },
            },
          ],
        },
      ],
      "C:/repo",
    );

    expect(history[0]?.lineRanges).toBeUndefined();
  });

  it("keeps only the newest bounded mutations", () => {
    const history = readPersistedProvenanceHistory(
      [
        {
          activities: [
            completed("turn-1", "2026-09-01T10:00:00.000Z"),
            completed("turn-2", "2026-09-01T10:01:00.000Z"),
            completed("turn-3", "2026-09-01T10:02:00.000Z"),
          ],
        },
      ],
      "C:/repo",
      2,
    );

    expect(history.map((mutation) => mutation.turnId)).toEqual(["turn-2", "turn-3"]);
  });
});
