import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  checksNotRun,
  computeVerificationVerdict,
  runDelegationChecks,
  type DelegationCheckResult,
  type DelegationVerificationStatus,
} from "./delegation-checks.js";
import type {
  DelegationGovernanceRecord,
  DelegationGovernanceStore,
  DelegationIntegrationState,
} from "./delegation-governance-store.js";
import { outOfScopeFiles } from "./delegation-policy.js";
import { loadDelegationRoutingConfig } from "./delegation-routing.js";
import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DelegationControlError,
  EXTERNAL_CLIENT_TOKEN_ENV,
  EXTERNAL_CLIENT_TOKEN_FILE_ENV,
  type DelegationControlApi,
  type DelegationThreadStatus,
} from "./delegation-types.js";
import {
  isCommitOid,
  isSymbolicLink,
  managedWorktreeParent,
  managedWorktreePath,
  parseWorktreeList,
  resolveComparablePath,
  samePath,
} from "./delegation-worktree.js";

const execFileAsync = promisify(execFile);
const MAX_PATCH_BUFFER = 64 * 1024 * 1024;
const CHECK_STRIPPED_ENV_KEYS = new Set([
  DELEGATION_RUNTIME_ENDPOINT_ENV.toUpperCase(),
  DELEGATION_RUNTIME_TOKEN_ENV.toUpperCase(),
  EXTERNAL_CLIENT_TOKEN_ENV.toUpperCase(),
  EXTERNAL_CLIENT_TOKEN_FILE_ENV.toUpperCase(),
]);
const SENSITIVE_ENV_KEY =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|AUTH|COOKIE|PRIVATE_KEY|CREDENTIAL)/iu;

function buildCheckEnvironment(baseEnv: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  redact: string[];
} {
  const env: NodeJS.ProcessEnv = {};
  const redact: string[] = [];
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    const stripped = CHECK_STRIPPED_ENV_KEYS.has(key.toUpperCase());
    if (stripped || SENSITIVE_ENV_KEY.test(key)) {
      if (value.length > 0) redact.push(value);
    }
    if (!stripped) {
      env[key] = value;
    }
  }
  return { env, redact };
}

/** True when `target` exists on disk, including broken symbolic links. */
function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

async function gitRaw(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.quotePath=false",
        "-c",
        "core.fsmonitor=false",
        "-C",
        cwd,
        ...args,
      ],
      {
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: MAX_PATCH_BUFFER,
        windowsHide: true,
        env: options.env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    if (options.allowFailure) {
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
        code: typeof failure.code === "number" ? failure.code : 1,
      };
    }
    throw new DelegationControlError(
      "INTERNAL_ERROR",
      `git ${args[0] ?? ""} failed: ${(failure.stderr || failure.message).trim()}`,
    );
  }
}

function terminalStatus(status: DelegationThreadStatus | string): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

/**
 * Collects everything changed inside an isolated worktree relative to `baseCommit`
 * using a temporary Git index (so the worktree's real index stays untouched) and
 * produces the file list, binary-safe patch, and diffstat summary.
 */
export async function collectWorktreeChanges(
  worktreePath: string,
  baseCommit: string,
): Promise<{ files: string[]; patch: string; stat: string }> {
  if (!isCommitOid(baseCommit)) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `Worktree baseline must be a full commit id: ${baseCommit}`,
    );
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-wt-index-"));
  const tempIndex = path.join(tempDir, "index");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_INDEX_FILE: tempIndex,
  };
  try {
    // Seed from HEAD so tracked-but-gitignored files are preserved without mutating .git/index.
    await gitRaw(worktreePath, ["read-tree", "HEAD"], { allowFailure: true, env });
    await gitRaw(worktreePath, ["add", "-A"], { env });
    const names = await gitRaw(
      worktreePath,
      ["diff", "--cached", "--name-only", "-z", "--no-renames", baseCommit, "--"],
      { env },
    );
    const patch = await gitRaw(
      worktreePath,
      ["diff", "--cached", "--binary", "--no-renames", baseCommit, "--"],
      { env },
    );
    const stat = await gitRaw(
      worktreePath,
      ["diff", "--cached", "--stat=200", "--no-renames", baseCommit, "--"],
      { env },
    );
    return {
      files: names.stdout.split("\0").filter(Boolean),
      patch: patch.stdout,
      stat: stat.stdout.trim(),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Dry-runs `git apply --check`, then applies the patch unstaged into the main repository. */
export async function applyWorktreePatch(repoRoot: string, patchFile: string): Promise<void> {
  if (!fs.existsSync(patchFile) || fs.statSync(patchFile).size === 0) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "The delegated Thread changed nothing, so there is no patch to apply",
    );
  }
  const check = await gitRaw(repoRoot, ["apply", "--check", "--whitespace=nowarn", patchFile], {
    allowFailure: true,
  });
  if (check.code !== 0) {
    throw new DelegationControlError(
      "APPLY_CONFLICT",
      `The patch does not apply cleanly to the working tree: ${check.stderr.trim()}`,
    );
  }
  await gitRaw(repoRoot, ["apply", "--whitespace=nowarn", patchFile]);
}

/**
 * Safely removes a worktree checkout and its branch. Only a registered, unlocked checkout at
 * the managed path for the branch is removed; unregistered directories are never deleted.
 */
export async function removeWorktreeCheckout(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<{ worktreeRemoved: boolean; branchRemoved: boolean }> {
  const repositoryExists = pathExists(repoRoot);
  const worktreeExists = pathExists(worktreePath);
  // A deleted source checkout may still be recoverable through the worktree's own Git link.
  const cwd = repositoryExists ? repoRoot : worktreeExists ? worktreePath : undefined;
  if (!cwd) return { worktreeRemoved: false, branchRemoved: false };

  // Invalid branch names must not resolve to the repository's parent or the .worktrees directory.
  const managedParent = await managedWorktreeParent(cwd);
  const managedPath = await managedWorktreePath(cwd, branch);
  // Refuse symbolic links at the managed directory or checkout path so non-managed targets stay safe.
  if (
    (await isSymbolicLink(managedParent)) ||
    (await isSymbolicLink(managedPath)) ||
    (await isSymbolicLink(worktreePath))
  ) {
    return { worktreeRemoved: false, branchRemoved: false };
  }
  const canonicalWorktree = await resolveComparablePath(worktreePath);
  // Never remove a checkout or delete a branch unless the recorded path matches the managed path.
  if (!samePath(canonicalWorktree, managedPath)) {
    return { worktreeRemoved: false, branchRemoved: false };
  }
  const listed = await gitRaw(cwd, ["worktree", "list", "--porcelain", "-z"], {
    allowFailure: true,
  });
  if (listed.code !== 0) return { worktreeRemoved: false, branchRemoved: false };
  const entries = parseWorktreeList(listed.stdout);
  let entry: ReturnType<typeof parseWorktreeList>[number] | undefined;
  for (const candidate of entries.slice(1)) {
    if (samePath(await resolveComparablePath(candidate.path), canonicalWorktree)) {
      entry = candidate;
      break;
    }
  }
  const mainPath = entries[0]?.path;
  const gitCwd = mainPath && fs.existsSync(mainPath) ? mainPath : cwd;

  if (entry && !entry.prunable) {
    if (
      entry.branch !== `refs/heads/${branch}` ||
      entry.locked === true ||
      !samePath(await resolveComparablePath(entry.path), managedPath)
    ) {
      return { worktreeRemoved: false, branchRemoved: false };
    }
    const removed = await gitRaw(gitCwd, ["worktree", "remove", "--force", "--", entry.path], {
      allowFailure: true,
    });
    if (removed.code !== 0) return { worktreeRemoved: false, branchRemoved: false };
    const branchResult = await gitRaw(gitCwd, ["branch", "-D", "--", branch], {
      allowFailure: true,
    });
    return { worktreeRemoved: true, branchRemoved: branchResult.code === 0 };
  }

  // Only prune and drop the branch when Git still records a matching unlocked prunable entry
  // whose directory is gone; never prune unrelated checkouts or delete detached/unmatched branches.
  if (
    worktreeExists ||
    !entry?.prunable ||
    entry.locked === true ||
    entry.branch !== `refs/heads/${branch}`
  ) {
    return { worktreeRemoved: false, branchRemoved: false };
  }
  await gitRaw(gitCwd, ["worktree", "prune"], { allowFailure: true });
  const branchResult = await gitRaw(gitCwd, ["branch", "-D", "--", branch], {
    allowFailure: true,
  });
  return { worktreeRemoved: true, branchRemoved: branchResult.code === 0 };
}

export interface ThreadVerifyResult {
  threadId: string;
  status: DelegationThreadStatus;
  tier?: string;
  integration: DelegationIntegrationState;
  verification: DelegationVerificationStatus;
  ok: boolean;
  checks: DelegationCheckResult[];
  changedFiles: string[];
  outOfScope: string[];
  patchPath?: string;
  patchStat?: string;
  warnings: string[];
}

export interface ThreadApplyResult {
  threadId: string;
  applied: true;
  files: string[];
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  note: string;
}

export interface ThreadDiscardResult {
  threadId: string;
  discarded: true;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  /** Present when artifacts could not be removed and need manual inspection. */
  note?: string;
}

function requireRecord(
  store: DelegationGovernanceStore,
  threadId: string,
): DelegationGovernanceRecord {
  const record = store.get(threadId);
  if (!record) {
    throw new DelegationControlError(
      "THREAD_NOT_FOUND",
      `No governance record exists for Thread ${threadId}. Start the Thread with --tier, --scope or --check to govern it; a plain --worktree delegation is not governed.`,
    );
  }
  return record;
}

async function resolveCurrentStatus(
  api: Pick<DelegationControlApi, "read">,
  record: DelegationGovernanceRecord,
): Promise<{ status: DelegationThreadStatus; turnId?: string; cwd?: string }> {
  try {
    const snapshot = await api.read({ threadId: record.threadId, view: "result" });
    return {
      status: snapshot.status,
      ...(snapshot.turn?.turnId ? { turnId: snapshot.turn.turnId } : {}),
      ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
    };
  } catch (error) {
    if (terminalStatus(record.status)) {
      return { status: record.status as DelegationThreadStatus };
    }
    throw error;
  }
}

async function listUntrackedFiles(worktreePath: string): Promise<Set<string> | undefined> {
  const result = await gitRaw(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"], {
    allowFailure: true,
  });
  if (result.code !== 0) return undefined;
  return new Set(result.stdout.split("\0").filter(Boolean));
}

/**
 * Verifies a finished governed Thread: collects its binary patch relative to the baseline commit
 * BEFORE running checks (so check-generated files cannot pollute the patch or scope audit),
 * runs declared checks in its workspace/worktree with secret redaction, and persists the verdict.
 */
export async function verifyGovernedThread(input: {
  threadId: string;
  api: Pick<DelegationControlApi, "read">;
  store: DelegationGovernanceStore;
  environment?: NodeJS.ProcessEnv;
}): Promise<ThreadVerifyResult> {
  const initial = requireRecord(input.store, input.threadId);
  if (initial.integration !== "none") {
    throw new DelegationControlError(
      "ALREADY_INTEGRATED",
      `Thread ${initial.threadId} was already ${initial.integration}`,
    );
  }
  const live = await resolveCurrentStatus(input.api, initial);
  const currentStatus = live.status;
  if (!terminalStatus(currentStatus)) {
    throw new DelegationControlError(
      "THREAD_BUSY",
      `Thread ${input.threadId} is still ${currentStatus}; wait for it to finish before verifying`,
    );
  }

  const routing = loadDelegationRoutingConfig({
    ...(initial.sourceRepoRoot ? { repoRoot: initial.sourceRepoRoot } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(initial.plannerHarnessId ? { plannerHarnessId: initial.plannerHarnessId } : {}),
    ...(initial.profile ? { explicitProfile: initial.profile } : {}),
  });

  const targetCwd = initial.worktree?.path ?? initial.sourceRepoRoot ?? initial.cwd ?? live.cwd;
  if (!targetCwd || !fs.existsSync(targetCwd)) {
    throw new DelegationControlError(
      "UNSUPPORTED",
      `Workspace for Thread ${input.threadId} is no longer present on disk`,
    );
  }

  // Collect changes before running checks so build/test artifacts created by checks are excluded.
  // Re-verifying the same Turn reuses its patch: checks may rewrite tracked files after collection.
  const reusePatch =
    initial.worktree !== undefined &&
    initial.verifiedTurnId !== undefined &&
    live.turnId !== undefined &&
    initial.verifiedTurnId === live.turnId &&
    initial.patchPath !== undefined &&
    fs.existsSync(initial.patchPath);
  let changedFiles: string[] = [];
  let patchStat = "";
  let patchPath: string | undefined;
  if (reusePatch) {
    changedFiles = [...(initial.changedFiles ?? [])];
    patchStat = initial.patchStat ?? "";
    patchPath = initial.patchPath;
  } else if (initial.worktree) {
    const collected = await collectWorktreeChanges(initial.worktree.path, initial.worktree.base);
    changedFiles = collected.files;
    patchStat = collected.stat;
    patchPath = input.store.writePatch(input.threadId, collected.patch);
  }

  const checkEnv = buildCheckEnvironment(input.environment ?? process.env);
  const executionOk = currentStatus === "completed";
  const warnings = [...initial.warnings];
  const preCheckUntracked =
    initial.worktree && executionOk && initial.checks.length > 0
      ? await listUntrackedFiles(initial.worktree.path)
      : undefined;
  let checks: DelegationCheckResult[];
  try {
    checks = executionOk
      ? await runDelegationChecks(initial.checks, {
          cwd: targetCwd,
          env: checkEnv.env,
          redact: checkEnv.redact,
          timeoutMs: routing.checks.timeoutMinutes * 60_000,
          logDir: input.store.paths(input.threadId).checksDir,
          ...(routing.checks.shell ? { shell: routing.checks.shell } : {}),
        })
      : checksNotRun(initial.checks, `not run: the delegated Thread ended ${currentStatus}`);
  } finally {
    // Clean up only untracked files created by checks so re-verifying never sweeps them into patches.
    // Any failed listing makes the before/after difference unreliable, so leave files untouched.
    if (initial.worktree && preCheckUntracked !== undefined) {
      const postCheckUntracked = await listUntrackedFiles(initial.worktree.path);
      if (postCheckUntracked !== undefined) {
        const worktreeRoot = path.resolve(initial.worktree.path);
        for (const relativeFile of postCheckUntracked) {
          if (preCheckUntracked.has(relativeFile)) continue;
          const fullPath = path.resolve(worktreeRoot, relativeFile);
          const rel = path.relative(worktreeRoot, fullPath);
          if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
            continue;
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } catch (error) {
            warnings.push(
              `Could not remove check-generated file ${relativeFile}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }
  }

  const strays = initial.write ? outOfScopeFiles(changedFiles, initial.scope) : [...changedFiles];
  if (
    initial.tier === "light" &&
    changedFiles.length > routing.light.maxChangedFiles &&
    !warnings.some((warning) => warning.includes("light tier changed"))
  ) {
    warnings.push(
      `A light tier changed ${changedFiles.length} files (more than ${routing.light.maxChangedFiles}).`,
    );
  }
  if (
    !initial.write &&
    changedFiles.length > 0 &&
    !warnings.some((warning) => warning.includes("read-only review changed files"))
  ) {
    warnings.push("A read-only review changed files; all of them are reported as out of scope.");
  }

  const verdict = computeVerificationVerdict({ executionOk, checks });
  const finalStatus: DelegationThreadStatus =
    currentStatus === "completed" && !verdict.ok ? "failed" : currentStatus;
  const saved = input.store.update(input.threadId, (draft) => {
    draft.status = finalStatus;
    draft.verification = verdict.verification;
    draft.checkResults = checks;
    draft.changedFiles = changedFiles;
    draft.outOfScope = strays;
    if (patchPath !== undefined) draft.patchPath = patchPath;
    draft.patchStat = patchStat;
    draft.warnings = warnings;
    draft.verifiedAt = new Date().toISOString();
    if (live.turnId !== undefined) draft.verifiedTurnId = live.turnId;
    else delete draft.verifiedTurnId;
  });

  const record = saved ?? initial;
  return {
    threadId: record.threadId,
    status: finalStatus,
    ...(record.tier ? { tier: record.tier } : {}),
    integration: record.integration,
    verification: verdict.verification,
    ok: verdict.ok,
    checks,
    changedFiles,
    outOfScope: strays,
    ...(patchPath ? { patchPath } : {}),
    ...(patchStat ? { patchStat } : {}),
    warnings,
  };
}

/**
 * Applies a governed worktree Thread's patch into its source repository (unstaged),
 * then removes the worktree and branch and releases its write-scope claim.
 * Callers must hold `store.withThreadLock(threadId)` around this call; only the final
 * patch-apply and state transition acquire the store-wide `store.withLock`.
 */
export async function applyGovernedThread(input: {
  threadId: string;
  allowOutOfScope?: boolean;
  force?: boolean;
  api: Pick<DelegationControlApi, "read">;
  store: DelegationGovernanceStore;
  environment?: NodeJS.ProcessEnv;
  /** Serializes only patch application and integration persistence with other dispatches. */
  withSourceLock?: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<ThreadApplyResult> {
  let record = requireRecord(input.store, input.threadId);
  if (record.integration !== "none") {
    throw new DelegationControlError(
      "ALREADY_INTEGRATED",
      `Thread ${record.threadId} was already ${record.integration}`,
    );
  }
  if (!record.write) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `Thread ${record.threadId} is a read-only review; discard it instead of applying`,
    );
  }
  if (!record.worktree || !record.sourceRepoRoot) {
    throw new DelegationControlError(
      "UNSUPPORTED",
      `Thread ${record.threadId} has no isolated worktree patch to apply`,
    );
  }
  const live = await resolveCurrentStatus(input.api, record);
  if (!terminalStatus(live.status)) {
    throw new DelegationControlError(
      "THREAD_BUSY",
      `Thread ${record.threadId} is still ${live.status}; wait for it to finish before applying`,
    );
  }
  const patchCandidate = record.patchPath ?? input.store.paths(record.threadId).patchFile;
  const staleVerification =
    !record.verifiedAt ||
    !fs.existsSync(patchCandidate) ||
    live.turnId === undefined ||
    live.turnId !== record.verifiedTurnId;
  let verifiedStatus: DelegationThreadStatus | undefined;
  if (staleVerification) {
    const verified = await verifyGovernedThread({
      threadId: input.threadId,
      api: input.api,
      store: input.store,
      ...(input.environment ? { environment: input.environment } : {}),
    });
    verifiedStatus = verified.status;
    record = requireRecord(input.store, input.threadId);
  }
  if (!record.worktree || !record.sourceRepoRoot) {
    throw new DelegationControlError(
      "UNSUPPORTED",
      `Thread ${record.threadId} has no isolated worktree patch to apply`,
    );
  }
  const { worktree, sourceRepoRoot } = record;
  const effectiveStatus =
    verifiedStatus ?? (record.verification === "failed" ? "failed" : live.status);
  if (!terminalStatus(effectiveStatus)) {
    throw new DelegationControlError(
      "THREAD_BUSY",
      `Thread ${record.threadId} is still ${effectiveStatus}`,
    );
  }
  if (
    (effectiveStatus !== "completed" ||
      record.verification === "failed" ||
      (record.checks.length > 0 && record.verification !== "passed")) &&
    input.force !== true
  ) {
    throw new DelegationControlError(
      "CHECKS_FAILED",
      `Thread ${record.threadId} ended ${effectiveStatus} (verification: ${record.verification ?? "unverified"}); pass --force true to apply anyway`,
      { status: effectiveStatus, verification: record.verification },
    );
  }
  if ((record.outOfScope?.length ?? 0) > 0 && input.allowOutOfScope !== true) {
    throw new DelegationControlError(
      "OUT_OF_SCOPE",
      `Thread ${record.threadId} changed files outside its declared scope: ${(record.outOfScope ?? []).join(", ")}; pass --allow-out-of-scope true after reviewing them`,
      { outOfScope: record.outOfScope },
    );
  }

  // Only patch application and integration persistence need the store-wide lock.
  const withSourceLock =
    input.withSourceLock ?? (<T>(operation: () => Promise<T>) => input.store.withLock(operation));
  await withSourceLock(async () => {
    const latest = requireRecord(input.store, input.threadId);
    if (latest.integration !== "none") {
      throw new DelegationControlError(
        "ALREADY_INTEGRATED",
        `Thread ${latest.threadId} was already ${latest.integration}`,
      );
    }
    const patchFile = latest.patchPath ?? input.store.paths(latest.threadId).patchFile;
    await applyWorktreePatch(sourceRepoRoot, patchFile);

    // Persist applied integration state BEFORE worktree cleanup so a cleanup failure
    // never leaves an applied patch appearing unapplied.
    input.store.update(latest.threadId, (draft) => {
      draft.integration = "applied";
      draft.appliedAt = new Date().toISOString();
    });
  });

  const cleanup = await removeWorktreeCheckout(
    sourceRepoRoot,
    worktree.path,
    worktree.branch,
  ).catch(() => ({ worktreeRemoved: false, branchRemoved: false }));
  const leftovers: string[] = [];
  if (!cleanup.worktreeRemoved) leftovers.push(`worktree ${worktree.path}`);
  if (!cleanup.branchRemoved) leftovers.push(`branch ${worktree.branch}`);
  const baseNote = "Changes were applied unstaged to your working tree. Review and commit them.";

  return {
    threadId: record.threadId,
    applied: true,
    files: record.changedFiles ?? [],
    worktreeRemoved: cleanup.worktreeRemoved,
    branchRemoved: cleanup.branchRemoved,
    note:
      leftovers.length > 0
        ? `${baseNote} Some artifacts could not be removed; inspect and clean them up manually: ${leftovers.join(", ")}.`
        : baseNote,
  };
}

/** Drops a finished governed Thread's worktree & branch and releases its write-scope claim. */
export async function discardGovernedThread(input: {
  threadId: string;
  api: Pick<DelegationControlApi, "read">;
  store: DelegationGovernanceStore;
}): Promise<ThreadDiscardResult> {
  const record = requireRecord(input.store, input.threadId);
  if (record.integration !== "none") {
    throw new DelegationControlError(
      "ALREADY_INTEGRATED",
      `Thread ${record.threadId} was already ${record.integration}`,
    );
  }
  const { status: currentStatus } = await resolveCurrentStatus(input.api, record);
  if (!terminalStatus(currentStatus)) {
    throw new DelegationControlError(
      "THREAD_BUSY",
      `Thread ${record.threadId} is still ${currentStatus}; cancel it first`,
    );
  }
  let cleanup = { worktreeRemoved: true, branchRemoved: true };
  if (record.worktree && record.sourceRepoRoot) {
    cleanup = await removeWorktreeCheckout(
      record.sourceRepoRoot,
      record.worktree.path,
      record.worktree.branch,
    ).catch(() => ({ worktreeRemoved: false, branchRemoved: false }));
  }
  input.store.update(record.threadId, (draft) => {
    draft.status = currentStatus;
    draft.integration = "discarded";
    draft.discardedAt = new Date().toISOString();
  });
  const leftovers: string[] = [];
  if (!cleanup.worktreeRemoved && record.worktree)
    leftovers.push(`worktree ${record.worktree.path}`);
  if (!cleanup.branchRemoved && record.worktree) leftovers.push(`branch ${record.worktree.branch}`);
  return {
    threadId: record.threadId,
    discarded: true,
    worktreeRemoved: cleanup.worktreeRemoved,
    branchRemoved: cleanup.branchRemoved,
    ...(leftovers.length > 0
      ? {
          note: `Some artifacts could not be removed; inspect and clean them up manually: ${leftovers.join(", ")}.`,
        }
      : {}),
  };
}
