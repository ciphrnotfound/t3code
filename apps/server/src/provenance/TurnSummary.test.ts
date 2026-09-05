import { describe, expect, it } from "vite-plus/test";
import { summarizeProvenanceTurn } from "./TurnSummary.ts";

describe("summarizeProvenanceTurn", () => {
  it("turns the existing assistant response into compact readable context", () => {
    expect(
      summarizeProvenanceTurn(
        "## Done\n\nUpdated the [auth flow](https://example.com) and **kept sessions intact**.",
      ),
    ).toBe("Done Updated the auth flow and kept sessions intact.");
  });

  it("drops fenced code instead of leaking it into a history card", () => {
    expect(summarizeProvenanceTurn("Implemented the fix.\n```ts\nconst secret = 1;\n```"))
      .toBe("Implemented the fix.");
  });

  it("bounds persisted context without splitting an ordinary word", () => {
    const summary = summarizeProvenanceTurn("Updated " + "carefully ".repeat(40));
    expect(summary?.endsWith("…")).toBe(true);
    expect(summary?.length).toBeLessThanOrEqual(241);
    expect(summary).not.toContain("carefu…");
  });
});
