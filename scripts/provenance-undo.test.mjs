import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { undoApplyArgs, undoDiffArgs } from "../apps/server/src/provenance/UndoPatch.ts";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-undo-regression-"));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("t3-undo-regression-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const git = (args, input) =>
    execFileSync("git", args, {
      cwd: root,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: path.join(root, ".git", "empty-global-config"),
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  git(["init", "-q"]);
  git(["config", "user.name", "Undo regression"]);
  git(["config", "user.email", "undo-test@example.invalid"]);
  git(["config", "core.autocrlf", "false"]);
  const write = (file, text) => fs.writeFileSync(path.join(root, file), text);
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const commit = () => {
    git(["add", "."]);
    git(["commit", "-qm", "checkpoint"]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  return {
    root,
    git,
    write,
    read,
    commit,
    patch: (before, after) => git(undoDiffArgs(before, after)),
    check: (patch) => git(undoApplyArgs(true), patch),
    apply: (patch) => git(undoApplyArgs(), patch),
  };
}

const baseline = Array.from({ length: 30 }, (_, i) => `original line ${i + 1}\n`).join("");

test("undo preserves disjoint multiline edits, staged bytes, untracked files, and HEAD", (t) => {
  const f = fixture(t);
  f.write("auth.ts", baseline);
  f.write("billing.ts", "original billing\n");
  const before = f.commit();
  const target = baseline.replace("original line 5\n", "bad one\nbad two\nbad three\n");
  f.write("auth.ts", target);
  f.write("billing.ts", "bad billing\n");
  const after = f.commit();
  f.write("auth.ts", target.replace("original line 25", "later user change"));
  f.git(["add", "auth.ts"]);
  f.write("notes.txt", "untracked user notes\n");
  const index = f.git(["ls-files", "--stage"]);
  const patch = f.patch(before, after);
  const previewBytes = f.read("auth.ts");
  f.check(patch);
  assert.equal(f.read("auth.ts"), previewBytes);
  f.apply(patch);
  assert.equal(f.read("auth.ts"), baseline.replace("original line 25", "later user change"));
  assert.equal(f.read("billing.ts"), "original billing\n");
  assert.equal(f.read("notes.txt"), "untracked user notes\n");
  assert.equal(f.git(["ls-files", "--stage"]), index);
  assert.equal(f.git(["rev-parse", "HEAD"]).trim(), after);
});

test("a change arriving after preview refuses the entire multi-file application", (t) => {
  const f = fixture(t);
  f.write("a.txt", baseline);
  f.write("b.txt", baseline);
  const before = f.commit();
  const target = baseline.replace("original line 12", "target change");
  f.write("a.txt", target);
  f.write("b.txt", target);
  const after = f.commit();
  const patch = f.patch(before, after);
  f.check(patch);
  const concurrent = target.replace("target change", "newer user change");
  f.write("b.txt", concurrent);
  assert.throws(() => f.apply(patch));
  assert.equal(f.read("a.txt"), target);
  assert.equal(f.read("b.txt"), concurrent);
});

test("undo follows a multiline target shifted by an insertion above it", (t) => {
  const f = fixture(t);
  f.write("a.txt", baseline);
  const before = f.commit();
  const target = baseline.replace("original line 20\n", "bad first\nbad second\n");
  f.write("a.txt", target);
  const after = f.commit();
  f.write("a.txt", `user heading\nuser context\n${target}`);
  f.apply(f.patch(before, after));
  assert.equal(f.read("a.txt"), `user heading\nuser context\n${baseline}`);
});

test("undo of deleted lines restores them at the right location after lines shift", (t) => {
  const f = fixture(t);
  f.write("a.txt", baseline);
  const before = f.commit();
  f.write("a.txt", baseline.replace("original line 20\n", ""));
  const after = f.commit();
  f.write("a.txt", `user heading\n${f.read("a.txt")}`);
  f.apply(f.patch(before, after));
  assert.equal(f.read("a.txt"), `user heading\n${baseline}`);
});

test("undo must not remove another identical statement when the original was replaced", (t) => {
  const f = fixture(t);
  f.write("a.txt", baseline);
  const before = f.commit();
  const target = baseline.replace("original line 10", "return true;");
  f.write("a.txt", target);
  const after = f.commit();
  const live = target
    .replace("return true;", "user replacement")
    .replace("original line 25", "return true;");
  f.write("a.txt", live);
  assert.throws(() => f.apply(f.patch(before, after)));
  assert.equal(f.read("a.txt"), live);
});

test("created files with later additions are not deleted", (t) => {
  const f = fixture(t);
  f.write("base.txt", baseline);
  const before = f.commit();
  f.write("new.txt", "agent content\n");
  const after = f.commit();
  f.write("new.txt", "agent content\nuser content\n");
  assert.throws(() => f.apply(f.patch(before, after)));
  assert.equal(f.read("new.txt"), "agent content\nuser content\n");
});

test("restoring a deleted file refuses an untracked file reusing its name", (t) => {
  const f = fixture(t);
  f.write("base.txt", baseline);
  f.write("deleted.txt", "old content\n");
  const before = f.commit();
  fs.unlinkSync(path.join(f.root, "deleted.txt"));
  const after = f.commit();
  f.write("deleted.txt", "new user file\n");
  assert.throws(() => f.apply(f.patch(before, after)));
  assert.equal(f.read("deleted.txt"), "new user file\n");
});

test("missing checkpoint refs fail before any file is changed", (t) => {
  const f = fixture(t);
  f.write("a.txt", baseline);
  const after = f.commit();
  assert.throws(() => f.patch("refs/t3/missing", after));
  assert.equal(f.read("a.txt"), baseline);
});
