import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { undoApplyArgs, undoDiffArgs } from "../apps/server/src/provenance/UndoPatch.ts";

const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provenance-smoke-"));
const git = (args, input) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });

try {
  git(["init", "-q"]);
  git(["config", "user.email", "provenance-smoke@t3.local"]);
  git(["config", "user.name", "T3 Provenance Smoke Test"]);
  NodeFS.writeFileSync(NodePath.join(repo, "shared.txt"), "alpha\nbeta\ngamma\n");
  NodeFS.writeFileSync(NodePath.join(repo, "secondary.txt"), "secondary baseline\n");
  NodeFS.writeFileSync(NodePath.join(repo, "agent-b.txt"), "billing baseline\n");
  NodeFS.writeFileSync(
    NodePath.join(repo, "auth.ts"),
    `export function normalizeEmail(email: string) {
  return email;
}

export function isTrustedDomain(email: string) {
  const domain = email.split("@")[1] ?? "";
  return domain === "example.com";
}

export function canAccessWorkspace(role: "admin" | "member", isSuspended: boolean) {
  return role === "admin" && !isSuspended;
}
`,
  );
  git(["add", "."]);
  git(["commit", "-qm", "baseline"]);

  NodeFS.writeFileSync(NodePath.join(repo, "shared.txt"), "alpha\nagent A\ngamma\n");
  NodeFS.writeFileSync(NodePath.join(repo, "secondary.txt"), "secondary from agent A\n");
  NodeFS.writeFileSync(
    NodePath.join(repo, "auth.ts"),
    `export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isTrustedDomain(email: string) {
  const domain = email.split("@")[1] ?? "";
  return domain === "example.com";
}

export function canAccessWorkspace(role: "admin" | "member", isSuspended: boolean) {
  return role === "admin" && !isSuspended;
}
`,
  );
  const before = git(["rev-parse", "HEAD"]);
  git(["add", "."]);
  git(["commit", "-qm", "agent A"]);
  const after = git(["rev-parse", "HEAD"]);

  // Simulate later, disjoint work from another agent in the live workspace.
  NodeFS.writeFileSync(NodePath.join(repo, "agent-b.txt"), "billing baseline\nagent B\n");
  NodeFS.writeFileSync(
    NodePath.join(repo, "auth.ts"),
    `export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isTrustedDomain(email: string) {
  const domain = email.split("@")[1] ?? "";
  return domain === "example.com";
}

export function canAccessWorkspace(role: "admin" | "member", isSuspended: boolean) {
  return !isSuspended;
}
`,
  );
  const reversePatch = git(undoDiffArgs(before.trim(), after.trim()));
  if (!reversePatch.includes("agent A") || !reversePatch.includes("secondary from agent A"))
    throw new Error("smoke fixture did not produce the expected patch");
  git(undoApplyArgs(true), reversePatch);
  git(undoApplyArgs(), reversePatch);

  const shared = NodeFS.readFileSync(NodePath.join(repo, "shared.txt"), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  const agentB = NodeFS.readFileSync(NodePath.join(repo, "agent-b.txt"), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  if (shared !== "alpha\nbeta\ngamma\n") {
    throw new Error(`agent A change was not reverted: ${JSON.stringify(shared)}`);
  }
  const secondary = NodeFS.readFileSync(NodePath.join(repo, "secondary.txt"), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  if (secondary !== "secondary baseline\n") {
    throw new Error(`agent A secondary change was not reverted: ${JSON.stringify(secondary)}`);
  }
  if (agentB !== "billing baseline\nagent B\n") throw new Error("agent B change was overwritten");
  const auth = NodeFS.readFileSync(NodePath.join(repo, "auth.ts"), "utf8").replaceAll("\r\n", "\n");
  if (!auth.includes("return email;") || !auth.includes("return !isSuspended;")) {
    throw new Error("same-file work from agent B was not preserved during safe undo");
  }

  // A conflicting later edit must refuse the reverse patch and leave the file
  // untouched for manual review.
  NodeFS.writeFileSync(NodePath.join(repo, "shared.txt"), "alpha\nagent C\ngamma\n");
  NodeFS.writeFileSync(NodePath.join(repo, "secondary.txt"), "secondary from agent A\n");
  let conflictRefused = false;
  try {
    git(undoApplyArgs(true), reversePatch);
  } catch {
    conflictRefused = true;
  }
  if (!conflictRefused) throw new Error("conflicting later edit was not refused");
  let atomicApplyRefused = false;
  try {
    git(undoApplyArgs(), reversePatch);
  } catch {
    atomicApplyRefused = true;
  }
  if (!atomicApplyRefused) throw new Error("conflicting multi-file undo was not refused");
  const conflicted = NodeFS.readFileSync(NodePath.join(repo, "shared.txt"), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  if (conflicted !== "alpha\nagent C\ngamma\n") {
    throw new Error("conflict guard changed the workspace");
  }
  const secondaryAfterConflict = NodeFS.readFileSync(
    NodePath.join(repo, "secondary.txt"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  if (secondaryAfterConflict !== "secondary from agent A\n") {
    throw new Error("failed multi-file undo partially modified a non-conflicting file");
  }
  console.log(
    "Safe Undo smoke test passed: disjoint same-file work preserved, conflicts refused, and multi-file undo remained atomic.",
  );
} finally {
  NodeFS.rmSync(repo, { recursive: true, force: true });
}
