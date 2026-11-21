import { execFile } from "node:child_process";
import fs from "node:fs";
import { rm } from "node:fs/promises";
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
  DelegationControlError,
  type DelegationControlApi,
  type DelegationThreadStatus,
} from "./delegation-types.js";

const execFileAsync = promisify(execFile);
const MAX_PATCH_BUFFER = 64 * 1024 * 1024;

async function gitRaw(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
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
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
 * Stages everything changed inside an isolated worktree relative to `baseCommit`
 * and produces the file list, binary-safe patch, and diffstat summary.
 */
export async function collectWorktreeChanges(
  worktreePath: string,
  baseCommit: string,
): Promise<{ files: string[]; patch: string; stat: string }> {
  await gitRaw(worktreePath, ["add", "-A"]);
  const names = await gitRaw(worktreePath, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--no-renames",
    baseCommit,
  ]);
  const patch = await gitRaw(worktreePath, [
    "diff",
    "--cached",
    "--binary",
    "--no-renames",
    baseCommit,
  ]);
  const stat = await gitRaw(worktreePath, [
    "diff",
    "--cached",
    "--stat=200",
    "--no-renames",
    baseCommit,
  ]);
  return {
    files: names.stdout.split("\0").filter(Boolean),
    patch: patch.stdout,
    stat: stat.stdout.trim(),
  };
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

/** Safely removes a worktree checkout and deletes its branch; missing artifacts are ignored. */
export async function removeWorktreeCheckout(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<{ worktreeRemoved: boolean; branchRemoved: boolean }> {
  let worktreeRemoved = true;
  if (fs.existsSync(worktreePath)) {
    const removed = await gitRaw(repoRoot, ["worktree", "remove", "--force", worktreePath], {
      allowFailure: true,
    });
    if (removed.code !== 0) {
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        worktreeRemoved = false;
      }
    }
  }
  await gitRaw(repoRoot, ["worktree", "prune"], { allowFailure: true });
  const branchResult = await gitRaw(repoRoot, ["branch", "-D", "--", branch], {
    allowFailure: true,
  });
  return { worktreeRemoved, branchRemoved: branchResult.code === 0 };
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
}

function requireRecord(
  store: DelegationGovernanceStore,
  threadId: string,
): DelegationGovernanceRecord {
  const record = store.get(threadId);
  if (!record) {
    throw new DelegationControlError(
      "THREAD_NOT_FOUND",
      `No governance record exists for Thread ${threadId}. Start the Thread with --tier, --scope, --check, or --worktree.`,
    );
  }
  return record;
}

async function resolveCurrentStatus(
  api: Pick<DelegationControlApi, "read">,
  record: DelegationGovernanceRecord,
): Promise<DelegationThreadStatus> {
  try {
    const snapshot = await api.read({ threadId: record.threadId, view: "result" });
    return snapshot.status;
  } catch (error) {
    if (terminalStatus(record.status)) return record.status as DelegationThreadStatus;
    throw error;
  }
}

/**
 * Verifies a finished governed Thread: runs declared checks in its workspace/worktree,
 * collects its binary patch relative to the baseline commit, audits out-of-scope files,
 * and persists the verification verdict.
 */
export async function verifyGovernedThread(input: {
  threadId: string;
  api: Pick<DelegationControlApi, "read">;
  store: DelegationGovernanceStore;
  environment?: NodeJS.ProcessEnv;
}): Promise<ThreadVerifyResult> {
  const initial = requireRecord(input.store, input.threadId);
  const currentStatus = await resolveCurrentStatus(input.api, initial);
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

  const targetCwd = initial.worktree?.path ?? initial.sourceRepoRoot;
  if (!targetCwd || !fs.existsSync(targetCwd)) {
    throw new DelegationControlError(
      "UNSUPPORTED",
      `Workspace for Thread ${input.threadId} is no longer present on disk`,
    );
  }

  input.store.update(input.threadId, (draft) => {
    draft.status = "verifying";
  });

  const executionOk = currentStatus === "completed";
  const checks = executionOk
    ? await runDelegationChecks(initial.checks, {
        cwd: targetCwd,
        timeoutMs: routing.checks.timeoutMinutes * 60_000,
        logDir: input.store.paths(input.threadId).checksDir,
        ...(routing.checks.shell ? { shell: routing.checks.shell } : {}),
      })
    : checksNotRun(initial.checks, `not run: the delegated Thread ended ${currentStatus}`);

  let changedFiles: string[] = [];
  let patchStat = "";
  let patchPath: string | undefined;
  if (initial.worktree) {
    const collected = await collectWorktreeChanges(initial.worktree.path, initial.worktree.base);
    changedFiles = collected.files;
    patchStat = collected.stat;
    patchPath = input.store.writePatch(input.threadId, collected.patch);
  }

  const strays = initial.write ? outOfScopeFiles(changedFiles, initial.scope) : [...changedFiles];
  const warnings = [...initial.warnings];
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
 */
export async function applyGovernedThread(input: {
  threadId: string;
  allowOutOfScope?: boolean;
  force?: boolean;
  api: Pick<DelegationControlApi, "read">;
  store: DelegationGovernanceStore;
  environment?: NodeJS.ProcessEnv;
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
  if (!record.verifiedAt) {
    await verifyGovernedThread({
      threadId: input.threadId,
      api: input.api,
      store: input.store,
      ...(input.environment ? { environment: input.environment } : {}),
    });
    record = requireRecord(input.store, input.threadId);
  }
  if (!record.worktree || !record.sourceRepoRoot) {
    throw new DelegationControlError(
      "UNSUPPORTED",
      `Thread ${record.threadId} has no isolated worktree patch to apply`,
    );
  }
  const { worktree, sourceRepoRoot } = record;
  if (!terminalStatus(record.status)) {
    throw new DelegationControlError(
      "THREAD_BUSY",
      `Thread ${record.threadId} is still ${record.status}`,
    );
  }
  if ((record.status !== "completed" || record.verification === "failed") && input.force !== true) {
    throw new DelegationControlError(
      "CHECKS_FAILED",
      `Thread ${record.threadId} ended ${record.status} (verification: ${record.verification ?? "unverified"}); pass --force true to apply anyway`,
      { status: record.status, verification: record.verification },
    );
  }
  if ((record.outOfScope?.length ?? 0) > 0 && input.allowOutOfScope !== true) {
    throw new DelegationControlError(
      "OUT_OF_SCOPE",
      `Thread ${record.threadId} changed files outside its declared scope: ${(record.outOfScope ?? []).join(", ")}; pass --allow-out-of-scope true after reviewing them`,
      { outOfScope: record.outOfScope },
    );
  }
  const patchFile = record.patchPath ?? input.store.paths(record.threadId).patchFile;
  await applyWorktreePatch(sourceRepoRoot, patchFile);

  // Persist applied integration state BEFORE worktree cleanup so a cleanup failure
  // never leaves an applied patch appearing unapplied.
  input.store.update(record.threadId, (draft) => {
    draft.integration = "applied";
    draft.appliedAt = new Date().toISOString();
  });

  const cleanup = await removeWorktreeCheckout(
    sourceRepoRoot,
    worktree.path,
    worktree.branch,
  ).catch(() => ({ worktreeRemoved: false, branchRemoved: false }));

  return {
    threadId: record.threadId,
    applied: true,
    files: record.changedFiles ?? [],
    worktreeRemoved: cleanup.worktreeRemoved,
    branchRemoved: cleanup.branchRemoved,
    note: "Changes were applied unstaged to your working tree. Review and commit them.",
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
  const currentStatus = await resolveCurrentStatus(input.api, record);
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
    );
  }
  input.store.update(record.threadId, (draft) => {
    draft.status = currentStatus;
    draft.integration = "discarded";
    draft.discardedAt = new Date().toISOString();
  });
  return {
    threadId: record.threadId,
    discarded: true,
    worktreeRemoved: cleanup.worktreeRemoved,
    branchRemoved: cleanup.branchRemoved,
  };
}
