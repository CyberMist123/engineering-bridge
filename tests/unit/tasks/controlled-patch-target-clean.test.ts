import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoreError } from "../../../src/core/errors.js";
import { ControlledPatchService } from "../../../src/tasks/controlled-patch-service.js";
import { RegisteredWorkspaceTaskService } from "../../../src/tasks/registered-workspace-task-service.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-target-clean-")));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "note.txt"), "before\n");
  writeFileSync(join(root, "other.txt"), "other base\n");
  git(root, "add", "note.txt", "other.txt");
  git(root, "commit", "-qm", "base");
  return root;
}

function fixture(root: string): ControlledPatchService {
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => {
    throw new Error("submitted controlled patches must not invoke an executor");
  });
  return new ControlledPatchService(registry, tasks);
}

async function expectPrecondition(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof CoreError && error.code === "WORKSPACE_PRECONDITION_FAILED"
  );
}

const validPatch = `diff --git a/note.txt b/note.txt
index 90be1f3..3b18e51 100644
--- a/note.txt
+++ b/note.txt
@@ -1 +1 @@
-before
+after
`;

test("submit and APPLY allow unrelated unstaged tracked changes", async () => {
  const root = repository();
  const controlled = fixture(root);
  const head = git(root, "rev-parse", "HEAD").trim();
  writeFileSync(join(root, "other.txt"), "unrelated unstaged\n");

  const submitted = await controlled.submit({ workspace_id: "workspace", base_head: head, diff: validPatch });
  const applied = await controlled.apply({ patch_task_id: submitted.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
  assert.equal(readFileSync(join(root, "other.txt"), "utf8"), "unrelated unstaged\n");
  assert.equal(git(root, "diff", "--name-only", "--", "other.txt").trim(), "other.txt");
});

test("submit and APPLY allow unrelated staged tracked changes", async () => {
  const root = repository();
  const controlled = fixture(root);
  const head = git(root, "rev-parse", "HEAD").trim();
  writeFileSync(join(root, "other.txt"), "unrelated staged\n");
  git(root, "add", "other.txt");

  const submitted = await controlled.submit({ workspace_id: "workspace", base_head: head, diff: validPatch });
  const applied = await controlled.apply({ patch_task_id: submitted.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
  assert.equal(git(root, "diff", "--cached", "--name-only", "--", "other.txt").trim(), "other.txt");
});

test("submit rejects an unstaged change on the modified target", async () => {
  const root = repository();
  const controlled = fixture(root);
  const head = git(root, "rev-parse", "HEAD").trim();
  writeFileSync(join(root, "note.txt"), "target unstaged\n");

  await expectPrecondition(() => controlled.submit({ workspace_id: "workspace", base_head: head, diff: validPatch }));
});

test("submit rejects a staged change on the modified target even when the worktree matches HEAD", async () => {
  const root = repository();
  const controlled = fixture(root);
  const head = git(root, "rev-parse", "HEAD").trim();
  writeFileSync(join(root, "note.txt"), "target staged\n");
  git(root, "add", "note.txt");
  writeFileSync(join(root, "note.txt"), "before\n");

  assert.notEqual(git(root, "status", "--porcelain=v1", "--", "note.txt").trim(), "");
  await expectPrecondition(() => controlled.submit({ workspace_id: "workspace", base_head: head, diff: validPatch }));
});

test("submit rejects an unmerged modified target even when the worktree matches the patch base", async () => {
  const root = repository();
  const controlled = fixture(root);
  const head = git(root, "rev-parse", "HEAD").trim();
  const baseBlob = git(root, "rev-parse", "HEAD:note.txt").trim();
  const oursBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    encoding: "utf8",
    input: "ours\n"
  }).trim();
  const theirsBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    encoding: "utf8",
    input: "theirs\n"
  }).trim();
  git(root, "update-index", "--force-remove", "note.txt");
  execFileSync("git", ["update-index", "--index-info"], {
    cwd: root,
    encoding: "utf8",
    input: [
      `100644 ${baseBlob} 1\tnote.txt`,
      `100644 ${oursBlob} 2\tnote.txt`,
      `100644 ${theirsBlob} 3\tnote.txt`,
      ""
    ].join("\n")
  });
  writeFileSync(join(root, "note.txt"), "before\n");

  assert.match(git(root, "status", "--porcelain=v1", "--", "note.txt"), /^UU /u);
  await expectPrecondition(() => controlled.submit({ workspace_id: "workspace", base_head: head, diff: validPatch }));
});
