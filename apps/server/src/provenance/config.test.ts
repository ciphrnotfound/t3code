import { describe, expect, it } from "vite-plus/test";
import {
  isProvenanceEnabled,
  normalizeWorkspacePath,
  providerWorkspaceMismatch,
  workspacePathsEqual,
  worktreeMismatch,
} from "./config.ts";

describe("isProvenanceEnabled", () => {
  it("defaults to enabled", () => {
    expect(isProvenanceEnabled({})).toBe(true);
  });

  it("supports an explicit operator disable switch", () => {
    expect(isProvenanceEnabled({ T3_PROVENANCE_ENABLED: "0" })).toBe(false);
    expect(isProvenanceEnabled({ T3_PROVENANCE_ENABLED: "1" })).toBe(true);
  });
});

describe("worktreeMismatch", () => {
  it("only reports a mismatch when both paths are known and differ", () => {
    expect(worktreeMismatch(null, "C:/repo")).toBe(false);
    expect(worktreeMismatch("C:/repo", undefined)).toBe(false);
    expect(worktreeMismatch("C:/repo", "C:/repo")).toBe(false);
    expect(worktreeMismatch("C:/repo", "C:/other")).toBe(true);
  });

  it("does not report equivalent Windows path spellings as different worktrees", () => {
    expect(normalizeWorkspacePath("C:\\Repo\\feature\\")).toBe("c:/repo/feature");
    expect(workspacePathsEqual("C:\\Repo\\feature\\", "c:/repo/feature")).toBe(true);
    expect(worktreeMismatch("C:\\Repo\\feature\\", "c:/repo/feature")).toBe(false);
  });

  it("keeps POSIX path comparison case-sensitive", () => {
    expect(workspacePathsEqual("/repo/Feature/", "/repo/Feature")).toBe(true);
    expect(workspacePathsEqual("/repo/Feature", "/repo/feature")).toBe(false);
  });

  it("fails closed when a provider omits or changes its assigned cwd", () => {
    expect(providerWorkspaceMismatch("/repo/worktree", undefined)).toBe(true);
    expect(providerWorkspaceMismatch("/repo/worktree", "/repo/other")).toBe(true);
    expect(providerWorkspaceMismatch("/repo/worktree", "/repo/worktree/")).toBe(false);
    expect(providerWorkspaceMismatch(null, undefined)).toBe(false);
  });
});
