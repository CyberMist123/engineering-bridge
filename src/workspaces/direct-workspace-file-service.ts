import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { CoreError } from "../core/errors.js";
import {
  runBoundedGit,
  type GitProcessOptions,
  type GitStarter
} from "../executors/bounded-git-process.js";
import { RegisteredWorkspaceRegistry } from "./registered-workspace-registry.js";
import { isPathWithin } from "./workspace-paths.js";

export type WorkspaceFileOperation = "list" | "read" | "search";

export interface WorkspaceFileRequest {
  readonly workspace_id: string;
  readonly operation: WorkspaceFileOperation;
  readonly path?: string | undefined;
  readonly query?: string | undefined;
  readonly start_line?: number | undefined;
  readonly end_line?: number | undefined;
  readonly limit?: number | undefined;
  readonly case_sensitive?: boolean | undefined;
}

const MAX_READ_BYTES = 1_000_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;

export class DirectWorkspaceFileService {
  constructor(
    private readonly registry: RegisteredWorkspaceRegistry,
    private readonly startProcess: GitStarter = spawn,
    private readonly gitProcessOptions: GitProcessOptions = {}
  ) {}

  async execute(request: WorkspaceFileRequest): Promise<unknown> {
    const root = this.registry.resolve(request.workspace_id);
    switch (request.operation) {
      case "list":
        return this.list(root, request.path, request.limit ?? 100);
      case "read":
        if (request.path === undefined) throw new CoreError("UNSUPPORTED_ACTION");
        return this.read(root, request.path, request.start_line, request.end_line);
      case "search":
        if (request.query === undefined || request.query.length === 0) {
          throw new CoreError("UNSUPPORTED_ACTION");
        }
        return this.search(
          root,
          request.query,
          request.path,
          request.limit ?? 50,
          request.case_sensitive ?? false
        );
    }
  }

  private async list(root: string, prefixInput: string | undefined, limit: number): Promise<unknown> {
    const prefix = normalizeRepoPath(prefixInput ?? "", true);
    const [baseHead, paths] = await Promise.all([
      this.baseHead(root),
      this.trackedFiles(root)
    ]);
    const filtered = paths.filter((path) => matchesPrefix(path, prefix));
    return {
      base_head: baseHead,
      paths: filtered.slice(0, limit),
      truncated: filtered.length > limit
    };
  }

  private async read(
    root: string,
    pathInput: string,
    startLine: number | undefined,
    endLine: number | undefined
  ): Promise<unknown> {
    const path = normalizeRepoPath(pathInput, false);
    if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
      throw new CoreError("UNSUPPORTED_ACTION");
    }
    await this.assertTracked(root, path);
    const candidate = await this.safeRegularFile(root, path);
    const stats = await lstat(candidate);
    if (stats.size > MAX_READ_BYTES && startLine === undefined && endLine === undefined) {
      throw new CoreError("UNSUPPORTED_ACTION");
    }
    const [baseHead, source] = await Promise.all([
      this.baseHead(root),
      readFile(candidate, "utf8")
    ]);
    if (source.includes("\u0000")) throw new CoreError("UNSUPPORTED_ACTION");

    if (startLine === undefined && endLine === undefined) {
      return { base_head: baseHead, path, content: source };
    }

    const lines = source.split("\n");
    const first = startLine ?? 1;
    const last = endLine ?? Math.min(lines.length, first + 199);
    if (first < 1 || last < 1) throw new CoreError("UNSUPPORTED_ACTION");
    const content = lines.slice(first - 1, last).join("\n");
    return {
      base_head: baseHead,
      path,
      start_line: first,
      end_line: Math.min(last, lines.length),
      content,
      truncated: last < lines.length
    };
  }

  private async search(
    root: string,
    query: string,
    prefixInput: string | undefined,
    limit: number,
    caseSensitive: boolean
  ): Promise<unknown> {
    const prefix = normalizeRepoPath(prefixInput ?? "", true);
    const [baseHead, paths] = await Promise.all([
      this.baseHead(root),
      this.trackedFiles(root)
    ]);
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const matches: Array<{ path: string; line: number; text: string }> = [];

    for (const path of paths) {
      if (!matchesPrefix(path, prefix)) continue;
      let candidate: string;
      try {
        candidate = await this.safeRegularFile(root, path);
      } catch {
        continue;
      }
      const stats = await lstat(candidate);
      if (stats.size > MAX_SEARCH_FILE_BYTES) continue;
      let source: string;
      try {
        source = await readFile(candidate, "utf8");
      } catch {
        continue;
      }
      if (source.includes("\u0000")) continue;
      const lines = source.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index] ?? "";
        const haystack = caseSensitive ? text : text.toLocaleLowerCase();
        if (!haystack.includes(needle)) continue;
        matches.push({ path, line: index + 1, text: text.slice(0, 500) });
        if (matches.length >= limit) {
          return { base_head: baseHead, matches, truncated: true };
        }
      }
    }
    return { base_head: baseHead, matches, truncated: false };
  }

  private async safeRegularFile(root: string, path: string): Promise<string> {
    const candidate = resolve(root, ...path.split("/"));
    try {
      const [canonicalRoot, canonicalCandidate, stats] = await Promise.all([
        realpath(root),
        realpath(candidate),
        lstat(candidate)
      ]);
      if (!stats.isFile() || stats.isSymbolicLink() || !isPathWithin(canonicalRoot, canonicalCandidate)) {
        throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
      }
      return candidate;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }
  }

  private async assertTracked(root: string, path: string): Promise<void> {
    const result = await this.git(root, ["ls-files", "--error-unmatch", "--", path]);
    if (result.code !== 0) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  }

  private async trackedFiles(root: string): Promise<string[]> {
    const result = await this.git(root, ["ls-files", "-z"]);
    if (result.code !== 0) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return result.stdout.split("\u0000").filter((path) => path.length > 0);
  }

  private async baseHead(root: string): Promise<string> {
    const result = await this.git(root, ["rev-parse", "--verify", "HEAD"]);
    const head = result.stdout.trim();
    if (result.code !== 0 || !/^[0-9a-f]{40,64}$/iu.test(head)) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    return head;
  }

  private git(root: string, args: readonly string[]) {
    return runBoundedGit(
      this.startProcess,
      root,
      args,
      undefined,
      () => new CoreError("WORKSPACE_PRECONDITION_FAILED"),
      this.gitProcessOptions
    );
  }
}

function normalizeRepoPath(value: string, allowEmpty: boolean): string {
  if (value.includes("\u0000")) throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
  const portable = value.replaceAll("\\", "/");
  if (portable.length === 0) {
    if (allowEmpty) return "";
    throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
  }
  if (portable.startsWith("/") || portable.startsWith("//") || /^[A-Za-z]:/u.test(portable)) {
    throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
  }
  const parts = portable.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
  }
  return parts.join("/");
}

function matchesPrefix(path: string, prefix: string): boolean {
  return prefix.length === 0 || path === prefix || path.startsWith(`${prefix}/`);
}
