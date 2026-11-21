import { execFile } from "node:child_process";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { DelegationControlError } from "./delegation-types.js";

const execFileAsync = promisify(execFile);
const MAX_UNTRACKED_LISTED = 20;

export interface DelegationWorktree {
  path: string;
  branch: string;
  /** Resolved commit, including when the caller omitted --base (HEAD). */
  base: string;
  /** Present when includeUncommitted=true snapshotted uncommitted tracked edits via `git stash create`. */
  includesUncommitted?: boolean;
  /** Count of untracked files in the source repo (excluded from git snapshots). */
  untrackedCount?: number;
  /** Up to 20 sample untracked file paths, present only when includeUncommitted=true and untracked files exist. */
  untracked?: string[];
}

/** Resolves the Git repository top-level directory containing `cwd`, or null if outside Git. */
export async function resolveGitRepoRoot(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
    { timeout: 30_000, maxBuffer: 1_048_576, windowsHide: true },
  );
  return stdout.trim();
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function invalid(message: string): DelegationControlError {
  return new DelegationControlError("INVALID_ARGUMENT", message);
}

/** Checks the source checkout's own Git state, not another worktree's index. */
async function checkRepository(cwd: string): Promise<string> {
  let root: string;
  try {
    root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw invalid(`--worktree cwd is not a Git working tree: ${cwd}`);
  }
  for (const name of ["MERGE_HEAD", "rebase-merge", "rebase-apply"]) {
    const state = await git(root, ["rev-parse", "--path-format=absolute", "--git-path", name]);
    if (await exists(state))
      throw invalid(`Git working tree has an in-progress merge or rebase (${name}): ${root}`);
  }
  if (await git(root, ["ls-files", "--unmerged"]))
    throw invalid(`Git working tree has an unmerged index: ${root}`);
  return root;
}

function retainedError(error: unknown, worktree: DelegationWorktree): DelegationControlError {
  const original = error instanceof DelegationControlError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return new DelegationControlError(
    original?.code ?? "INTERNAL_ERROR",
    `${message}; worktree/branch may remain at ${worktree.path} (${worktree.branch})`,
    { ...original?.details, worktree, worktreeRetained: true },
  );
}

async function createWorktree(input: {
  cwd: string;
  branch: string;
  base?: string | undefined;
  includeUncommitted?: boolean | undefined;
}): Promise<DelegationWorktree> {
  const root = await checkRepository(input.cwd);
  // Validate the literal ref: --branch would expand checkout shorthand such as @{-1}.
  if (input.branch.startsWith("-") || input.branch === "HEAD")
    throw invalid(`Invalid worktree branch: ${input.branch}`);
  try {
    await git(root, ["check-ref-format", `refs/heads/${input.branch}`]);
  } catch {
    throw invalid(`Invalid worktree branch: ${input.branch}`);
  }
  const branches = await git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/"]);
  if (branches.split("\n").includes(`refs/heads/${input.branch}`))
    throw invalid(`Git branch already exists: ${input.branch}`);

  let base: string;
  let includesUncommitted: boolean | undefined;
  let untrackedCount: number | undefined;
  let untracked: string[] | undefined;
  if (input.includeUncommitted) {
    if (input.base !== undefined) {
      throw invalid("--include-uncommitted cannot be combined with --base");
    }
    let headCommit: string;
    try {
      headCommit = await git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    } catch {
      throw invalid("Cannot resolve HEAD commit for worktree snapshot");
    }
    const snapshot = await git(root, ["stash", "create"]);
    base = snapshot || headCommit;
    includesUncommitted = snapshot !== "";
    const untrackedRaw = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const untrackedList = untrackedRaw.split("\0").filter(Boolean);
    untrackedCount = untrackedList.length;
    if (untrackedList.length > 0) untracked = untrackedList.slice(0, MAX_UNTRACKED_LISTED);
  } else {
    try {
      base = await git(root, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${input.base ?? "HEAD"}^{commit}`,
      ]);
    } catch {
      throw invalid(`Cannot resolve worktree base to a commit: ${input.base ?? "HEAD"}`);
    }
  }
  // The first entry is the main working tree, even when cwd is a linked worktree.
  const listed = await git(root, ["worktree", "list", "--porcelain", "-z"]);
  const main = listed.split("\0")[0]?.slice("worktree ".length);
  if (!main || !path.isAbsolute(main)) throw invalid("Cannot determine the main Git worktree");
  const directory = input.branch.replace(/[^a-zA-Z0-9._-]/gu, "-");
  const parent = path.join(path.dirname(main), `${path.basename(main)}.worktrees`);
  const worktree: DelegationWorktree = {
    path: path.join(parent, directory),
    branch: input.branch,
    base,
    ...(includesUncommitted !== undefined ? { includesUncommitted } : {}),
    ...(untrackedCount !== undefined ? { untrackedCount } : {}),
    ...(untracked !== undefined ? { untracked } : {}),
  };
  if (await exists(worktree.path))
    throw invalid(`Worktree directory already exists: ${worktree.path}`);
  await mkdir(parent, { recursive: true });
  // Reserve the path exclusively before touching refs; never reuse an existing directory.
  try {
    await mkdir(worktree.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw invalid(`Worktree directory already exists: ${worktree.path}`);
    throw error;
  }
  let branchCreated = false;
  try {
    await git(root, ["branch", "--", input.branch, base]);
    branchCreated = true;
    // A linked checkout's .git is a file, so this hooks directory cannot exist.
    await git(root, [
      "-c",
      `core.hooksPath=${path.join(worktree.path, ".git", "hooks")}`,
      "worktree",
      "add",
      "--",
      worktree.path,
      input.branch,
    ]);
    return worktree;
  } catch (error) {
    if (branchCreated) {
      // A failed/timed-out checkout can leave files or registration; preserve and report them.
      throw retainedError(error, worktree);
    }
    const removed = await rmdir(worktree.path).then(
      () => true,
      () => false,
    );
    const refs = await git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).catch(
      () => undefined,
    );
    if (removed && refs !== undefined && !refs.split("\n").includes(`refs/heads/${input.branch}`)) {
      throw invalid(
        `Cannot create worktree branch '${input.branch}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw retainedError(error, worktree);
  }
}

/** Shared CLI/Host filesystem preparation; callers must resolve their own source cwd. */
export async function startWithDelegationWorktree(
  input: {
    cwd?: string | undefined;
    branch?: string | undefined;
    base?: string | undefined;
    includeUncommitted?: boolean | undefined;
  },
  start: (cwd: string | undefined, worktree?: DelegationWorktree) => Promise<unknown>,
): Promise<unknown> {
  if (input.branch === undefined) {
    if (input.base !== undefined) throw invalid("--base requires --worktree");
    if (input.includeUncommitted) throw invalid("--include-uncommitted requires --worktree");
    return start(input.cwd, undefined);
  }
  if (typeof input.branch !== "string" || !input.branch.trim())
    throw invalid("worktree must be a non-empty branch name");
  if (input.base !== undefined && (typeof input.base !== "string" || !input.base.trim()))
    throw invalid("base must be a non-empty ref");
  if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd))
    throw invalid("--worktree requires an absolute cwd");
  const worktree = await createWorktree({
    cwd: path.resolve(input.cwd),
    branch: input.branch,
    base: input.base,
    includeUncommitted: input.includeUncommitted,
  });
  try {
    const result = await start(worktree.path, worktree);
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new DelegationControlError("INTERNAL_ERROR", "Invalid delegation start response");
    return { ...result, worktree };
  } catch (error) {
    // A failed response does not prove that the Thread never started.
    throw retainedError(error, worktree);
  }
}
