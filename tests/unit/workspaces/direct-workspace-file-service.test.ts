import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoreError } from "../../../src/core/errors.js";
import { DirectWorkspaceFileService } from "../../../src/workspaces/direct-workspace-file-service.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";
import { isolateGitLineEndings } from "../../helpers/git-fixture.js";

test("memory workspace excludes password.kdbx from direct file operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "engineering-bridge-direct-files-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    isolateGitLineEndings(root);
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    writeFileSync(join(root, "visible.md"), "visible memory\n", "utf8");
    writeFileSync(join(root, "password.kdbx"), "not a database in this fixture\n", "utf8");
    execFileSync("git", ["add", "visible.md", "password.kdbx"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });

    const service = new DirectWorkspaceFileService(new RegisteredWorkspaceRegistry([{ id: "memory", root }]));
    const listed = await service.execute({ workspace_id: "memory", operation: "list" }) as { paths: string[] };
    assert.deepEqual(listed.paths, ["visible.md"]);

    const searched = await service.execute({ workspace_id: "memory", operation: "search", query: "visible" }) as {
      matches: Array<{ path: string }>;
    };
    assert.deepEqual(searched.matches.map(({ path }) => path), ["visible.md"]);

    await assert.rejects(
      service.execute({ workspace_id: "memory", operation: "read", path: "password.kdbx" }),
      (error: unknown) => error instanceof CoreError && error.code === "WORKSPACE_BOUNDARY_VIOLATION"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
