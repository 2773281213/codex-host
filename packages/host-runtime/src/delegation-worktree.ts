import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
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

/** Whether `target` exists and is a symbolic link (does not follow links). */
export async function isSymbolicLink(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function invalid(message: string): DelegationControlError {
  return new DelegationControlError("INVALID_ARGUMENT", message);
}

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Whether the value is a full lowercase Git object id (SHA-1 or SHA-256). */
export function isCommitOid(value: unknown): value is string {
  return typeof value === "string" && COMMIT_OID.test(value);
}

/** The directory name a managed worktree checkout uses for `branch`. */
export function worktreeDirectoryName(branch: string): string {
  if (typeof branch !== "string" || branch === "" || branch === "." || branch === "..")
    throw invalid(`Invalid worktree branch directory: ${String(branch)}`);
  const directory = branch.replace(/[^a-zA-Z0-9._-]/gu, "-");
  if (!directory || directory === "." || directory === "..")
    throw invalid(`Invalid worktree branch directory: ${branch}`);
  return directory;
}

/** Compares paths as the platform does: separators normalized, and case-insensitively on Windows. */
export function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Resolves a path for comparison, following symlinks on the path or its existing parent. */
export async function resolveComparablePath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    const resolved = path.resolve(value);
    const parent = path.dirname(resolved);
    if (parent !== resolved) {
      try {
        return path.join(await realpath(parent), path.basename(resolved));
      } catch {
        return resolved;
      }
    }
    return resolved;
  }
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export interface WorktreeListEntry {
  path: string;
  branch?: string;
  locked?: boolean;
  prunable?: boolean;
}

/** Entries of `git worktree list --porcelain -z`, main working tree first. */
export function parseWorktreeList(listed: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  for (const field of listed.split("\0")) {
    if (field.startsWith("worktree ")) entries.push({ path: field.slice("worktree ".length) });
    else if (entries.length === 0) continue;
    else if (field.startsWith("branch "))
      (entries.at(-1) as WorktreeListEntry).branch = field.slice("branch ".length);
    else if (field === "locked" || field.startsWith("locked "))
      (entries.at(-1) as WorktreeListEntry).locked = true;
    else if (field === "prunable" || field.startsWith("prunable "))
      (entries.at(-1) as WorktreeListEntry).prunable = true;
  }
  return entries;
}

/** The directory under which this repository's managed worktree checkouts live. */
export async function managedWorktreeParent(root: string): Promise<string> {
  const entries = parseWorktreeList(await git(root, ["worktree", "list", "--porcelain", "-z"]));
  const main = entries[0]?.path;
  if (!main || !path.isAbsolute(main)) throw invalid("Cannot determine the main Git worktree");
  // Resolve symlinks only above the main checkout so a symlinked .worktrees dir cannot redirect it.
  const mainParent = await resolveComparablePath(path.dirname(main));
  return path.join(mainParent, `${path.basename(main)}.worktrees`);
}

/** The only checkout path this tooling creates for `branch`. */
export async function managedWorktreePath(root: string, branch: string): Promise<string> {
  const parent = await managedWorktreeParent(root);
  const target = path.join(parent, worktreeDirectoryName(branch));
  // A managed checkout is always one directory directly under the managed parent.
  if (!samePath(path.dirname(target), parent))
    throw invalid(`Invalid managed worktree path for branch: ${branch}`);
  return target;
}

export interface VerifiedDelegationWorktree {
  root: string;
  worktree: DelegationWorktree;
}

/**
 * Confirms that `worktree` is a linked checkout registered with the source checkout at
 * `sourceRepoRoot` and on its recorded branch, and that `cwd` lies inside it. In-process callers
 * use this defense even though the Host creates governed worktrees itself: apply writes into the
 * source checkout and discard removes the worktree. Metadata is normalized to its known fields.
 */
export async function verifyDelegationWorktree(input: {
  sourceRepoRoot: unknown;
  worktree: unknown;
  cwd?: string | undefined;
}): Promise<VerifiedDelegationWorktree> {
  if (!input.worktree || typeof input.worktree !== "object" || Array.isArray(input.worktree))
    throw invalid("worktreeMetadata must be an object");
  const candidate = input.worktree as Record<string, unknown>;
  if (
    typeof candidate.path !== "string" ||
    !path.isAbsolute(candidate.path) ||
    typeof candidate.branch !== "string" ||
    !candidate.branch
  )
    throw invalid("worktreeMetadata must give an absolute worktree path and its branch");
  if (!isCommitOid(candidate.base)) throw invalid("worktreeMetadata.base must be a full commit id");
  const worktreePath = candidate.path;
  const branch = candidate.branch;
  const base = candidate.base;
  if (typeof input.sourceRepoRoot !== "string" || !path.isAbsolute(input.sourceRepoRoot))
    throw invalid("worktreeMetadata requires the absolute sourceRepoRoot it was created from");
  let root: string;
  try {
    root = await git(input.sourceRepoRoot, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw invalid(`sourceRepoRoot is not a Git working tree: ${input.sourceRepoRoot}`);
  }
  const canonicalRoot = await resolveComparablePath(root);
  if (!samePath(canonicalRoot, await resolveComparablePath(input.sourceRepoRoot)))
    throw invalid(`sourceRepoRoot must be the top level of its checkout: ${input.sourceRepoRoot}`);

  // A base must be the full object id `git diff` can use as one revision, never an option or ref.
  const resolvedBase = await git(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${base}^{commit}`,
  ]).catch(() => "");
  if (resolvedBase !== base)
    throw invalid(`worktreeMetadata.base is not a commit in ${root}: ${base}`);

  const expectedPath = await managedWorktreePath(root, branch);
  if (
    (await isSymbolicLink(path.dirname(expectedPath))) ||
    (await isSymbolicLink(expectedPath)) ||
    (await isSymbolicLink(worktreePath))
  )
    throw invalid(`The delegation worktree path must not be a symbolic link: ${worktreePath}`);
  const canonicalWorktree = await resolveComparablePath(worktreePath);
  if (samePath(canonicalWorktree, canonicalRoot))
    throw invalid("The delegation worktree must be separate from its source checkout");
  if (!samePath(canonicalWorktree, expectedPath))
    throw invalid(
      `The delegation worktree must be the managed checkout for branch ${branch}: ${expectedPath}`,
    );

  const entries = parseWorktreeList(await git(root, ["worktree", "list", "--porcelain", "-z"]));
  let entry: WorktreeListEntry | undefined;
  for (const listed of entries) {
    if (samePath(await resolveComparablePath(listed.path), canonicalWorktree)) {
      entry = listed;
      break;
    }
  }
  const main = entries[0];
  if (!entry || !main || samePath(await resolveComparablePath(main.path), canonicalWorktree))
    throw invalid(`${worktreePath} is not a linked worktree of ${root} on branch ${branch}`);
  if (entry.branch !== `refs/heads/${branch}`)
    throw invalid(`${worktreePath} is not a linked worktree of ${root} on branch ${branch}`);
  if (input.cwd !== undefined) {
    const canonicalCwd = await resolveComparablePath(input.cwd);
    if (!isWithin(canonicalCwd, canonicalWorktree))
      throw invalid(`cwd must be inside the delegation worktree ${worktreePath}`);
  }
  const ancestor = await git(root, ["merge-base", "--is-ancestor", base, `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false);
  if (!ancestor)
    throw invalid(`worktreeMetadata.base is not an ancestor of branch ${branch}: ${base}`);

  const normalized: DelegationWorktree = { path: worktreePath, branch, base };
  if (candidate.includesUncommitted !== undefined) {
    if (typeof candidate.includesUncommitted !== "boolean")
      throw invalid("worktreeMetadata.includesUncommitted must be a boolean");
    normalized.includesUncommitted = candidate.includesUncommitted;
  }
  if (candidate.untrackedCount !== undefined) {
    if (
      typeof candidate.untrackedCount !== "number" ||
      !Number.isSafeInteger(candidate.untrackedCount) ||
      candidate.untrackedCount < 0
    )
      throw invalid("worktreeMetadata.untrackedCount must be a non-negative integer");
    normalized.untrackedCount = candidate.untrackedCount;
  }
  if (candidate.untracked !== undefined) {
    if (
      !Array.isArray(candidate.untracked) ||
      candidate.untracked.length > MAX_UNTRACKED_LISTED ||
      candidate.untracked.some((item) => typeof item !== "string")
    )
      throw invalid(
        `worktreeMetadata.untracked must be an array of at most ${MAX_UNTRACKED_LISTED} strings`,
      );
    normalized.untracked = [...candidate.untracked];
  }
  return { root, worktree: normalized };
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
}): Promise<{ worktree: DelegationWorktree; root: string }> {
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
  const parent = await managedWorktreeParent(root);
  const worktree: DelegationWorktree = {
    path: path.join(parent, worktreeDirectoryName(input.branch)),
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
    return { worktree, root };
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

/**
 * Shared CLI/Host filesystem preparation; callers must resolve their own source cwd.
 * `start` receives the created worktree and the top level of the source checkout it came from.
 */
export async function startWithDelegationWorktree(
  input: {
    cwd?: string | undefined;
    branch?: string | undefined;
    base?: string | undefined;
    includeUncommitted?: boolean | undefined;
  },
  start: (
    cwd: string | undefined,
    worktree?: DelegationWorktree,
    sourceRoot?: string,
  ) => Promise<unknown>,
  /**
   * Called when `start` failed before the child existed. Returning true means the caller
   * reclaimed the checkout, so the original error is thrown without retained-worktree details.
   */
  onStartError?: (
    error: unknown,
    worktree: DelegationWorktree,
    sourceRoot: string,
  ) => Promise<boolean>,
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
  const { worktree, root } = await createWorktree({
    cwd: path.resolve(input.cwd),
    branch: input.branch,
    base: input.base,
    includeUncommitted: input.includeUncommitted,
  });
  try {
    const result = await start(worktree.path, worktree, root);
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new DelegationControlError("INTERNAL_ERROR", "Invalid delegation start response");
    return { ...result, worktree };
  } catch (error) {
    if (await onStartError?.(error, worktree, root).catch(() => false)) throw error;
    // A failed response does not prove that the Thread never started.
    throw retainedError(error, worktree);
  }
}
