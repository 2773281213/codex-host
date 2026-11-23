import {
  DEFAULT_LIGHT_MAX_CHANGED_FILES,
  DEFAULT_LIGHT_MAX_SCOPE_ENTRIES,
  DELEGATION_TIERS,
  type DelegationTier,
} from "@codexhost/shared-contracts";

import { DelegationControlError } from "./delegation-types.js";

export {
  DEFAULT_LIGHT_MAX_CHANGED_FILES,
  DEFAULT_LIGHT_MAX_SCOPE_ENTRIES,
  DELEGATION_TIERS,
  type DelegationTier,
};

/** Tiers whose delegated Threads may modify files inside their workspace/worktree. */
export const WRITE_DELEGATION_TIERS: ReadonlySet<DelegationTier> = new Set(["deep", "light"]);

/** Environment variable injected into governed child executors to block recursive delegation. */
export const DELEGATION_ROLE_ENV = "CODEXHOST_DELEGATION_ROLE";
export const DELEGATION_EXECUTOR_ROLE = "executor";

export const MAX_CHECKS = 20;
export const MAX_CHECK_CHARS = 2_000;
export const MAX_ACCEPTANCE_CHARS = 4_000;

// Project-relative path rule: no leading slash, no `.`/`..`/`.git` (any case) segment,
// no empty segment, no backslash, colon or control character. `.` alone means whole repo.
const PATH_RULE =
  /^(?!\/)(?!.*(?:^|\/)(?:\.\.?|\.[gG][iI][tT])(?:\/|$))(?!.*\/\/)(?!.*[\\:\u0000-\u001f\u007f])[^/].*[^/]$|^[^./\\:\u0000-\u001f\u007f]$/u;

export function isDelegationTier(value: unknown): value is DelegationTier {
  return typeof value === "string" && (DELEGATION_TIERS as readonly string[]).includes(value);
}

/**
 * A present field counts unless it is an empty list or a blank string; a malformed value still
 * opts in, so validation rejects it instead of silently starting an ungoverned Thread.
 */
function requested(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/**
 * Whether a start explicitly opts into governance. An isolated worktree alone does not:
 * plain `--worktree` delegations keep their ungoverned behavior (no executor role, no scope
 * lock, no verify/apply/discard). The CLI, the control server and the Registry all use this.
 * A present but malformed tier, profile or allowNestedDelegation opts in so entry validation
 * rejects it instead of silently starting an ungoverned executor.
 */
export function requestsGovernance(input: {
  tier?: unknown;
  profile?: unknown;
  scope?: unknown;
  checks?: unknown;
  acceptance?: unknown;
  allowNestedDelegation?: unknown;
}): boolean {
  const declared = (value: unknown): boolean => value !== undefined && value !== null;
  return (
    declared(input.tier) ||
    declared(input.profile) ||
    requested(input.scope) ||
    requested(input.checks) ||
    requested(input.acceptance) ||
    (declared(input.allowNestedDelegation) && input.allowNestedDelegation !== true)
  );
}

/** Validates and normalizes one scope entry (a project-relative file or directory path). */
export function normalizeScopePath(entry: unknown): string {
  if (typeof entry !== "string") {
    throw new DelegationControlError("INVALID_ARGUMENT", "Scope entries must be strings");
  }
  let value = entry.trim();
  if (value === "." || value === "./") return ".";
  if (value.startsWith("./")) value = value.slice(2);
  while (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  if (!PATH_RULE.test(value)) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `Scope entry "${entry}" must be a project-relative path without "..", ".git", backslashes or a leading slash`,
    );
  }
  return value;
}

/**
 * Whether a scope entry covers a project-relative file path (directory-prefix semantics).
 * Windows file systems ignore case, so paths that differ only in case are the same file there.
 */
export function coversScope(entry: string, file: string): boolean {
  if (entry === ".") return true;
  const [scope, target] =
    process.platform === "win32" ? [entry.toLowerCase(), file.toLowerCase()] : [entry, file];
  return target === scope || target.startsWith(`${scope}/`);
}

/** The first pair of overlapping entries between two scopes, or null. */
export function scopesOverlap(
  leftScope: readonly string[],
  rightScope: readonly string[],
): { left: string; right: string } | null {
  for (const left of leftScope) {
    for (const right of rightScope) {
      if (coversScope(left, right) || coversScope(right, left)) {
        return { left, right };
      }
    }
  }
  return null;
}

/** Project-relative files not covered by any entry of `scope`. */
export function outOfScopeFiles(files: readonly string[], scope: readonly string[]): string[] {
  return files.filter((file) => !scope.some((entry) => coversScope(entry, file)));
}

export interface ScopeHoldingRecord {
  threadId: string;
  write: boolean;
  status: string;
  integration: "none" | "applied" | "discarded";
  sourceRepoRoot?: string;
  scope: readonly string[];
  /** Absent means true; retained so records written by earlier versions keep their meaning. */
  claimsScope?: boolean;
  /** Present when the delegation runs in an isolated worktree whose patch is applied later. */
  worktree?: { path: string };
  /** Idempotency key and dispatching parent; a retry reuses the same values. */
  requestId?: string;
  parentThreadId?: string;
}

export const LIVE_DELEGATION_STATUSES: ReadonlySet<string> = new Set([
  "creating",
  "queued",
  "running",
  "verifying",
]);

/**
 * Whether a governed delegation still claims its write scope. A worktree delegation holds its
 * scope until its patch is applied or discarded, including after the Thread stops. A delegation
 * that edited the shared workspace directly has nothing left to integrate once it stops.
 */
export function holdsWriteScope(
  record: Pick<ScopeHoldingRecord, "write" | "status" | "integration" | "claimsScope" | "worktree">,
): boolean {
  if (!record.write || record.claimsScope === false) return false;
  if (record.worktree) return record.integration === "none";
  return LIVE_DELEGATION_STATUSES.has(record.status);
}

/** Enforces the anti-recursion guard for executor Threads. */
export function checkExecutorRoleGuard(input: {
  callerRole?: string;
  callerIsExecutorThread?: boolean;
}): void {
  if (input.callerRole === DELEGATION_EXECUTOR_ROLE || input.callerIsExecutorThread) {
    throw new DelegationControlError(
      "EXECUTOR_ROLE_FORBIDDEN",
      `This Thread runs as a delegated executor (${DELEGATION_ROLE_ENV}=${DELEGATION_EXECUTOR_ROLE}); executors may not dispatch further delegated Threads.`,
    );
  }
}

export interface GovernancePolicyInput {
  tier?: DelegationTier;
  scope?: readonly string[];
  checks?: readonly string[];
  acceptance?: string;
  sourceRepoRoot?: string;
  existingRecords?: readonly ScopeHoldingRecord[];
  maxLightScopeEntries?: number;
  /** A retry with the same requestId from the same parent is not its own conflict. */
  requestId?: string;
  parentThreadId?: string;
}

export interface NormalizedGovernancePlan {
  tier?: DelegationTier;
  write: boolean;
  scope: string[];
  /** Whether the delegation locks its effective scope against other writers (true for write tasks). */
  claimsScope: boolean;
  checks: string[];
  acceptance?: string;
}

function normalizeText(value: unknown, field: string, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new DelegationControlError("INVALID_ARGUMENT", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxChars) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `${field} must be at most ${maxChars} characters`,
    );
  }
  return trimmed;
}

function normalizeChecks(raw: readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new DelegationControlError("INVALID_ARGUMENT", "checks must be a list of commands");
  }
  if (raw.length > MAX_CHECKS) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `At most ${MAX_CHECKS} checks may be declared`,
    );
  }
  return raw.map((command, index) => {
    const cleaned = normalizeText(command, `checks[${index}]`, MAX_CHECK_CHARS);
    if (!cleaned) {
      throw new DelegationControlError("INVALID_ARGUMENT", `checks[${index}] must not be empty`);
    }
    return cleaned;
  });
}

function normalizeRepoKey(repoRoot: string): string {
  const normalized = repoRoot.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Pure policy check for governed delegation: validates tier rules, scope paths,
 * verification commands, and concurrent write-scope conflicts in the same repository.
 */
export function validateGovernancePolicy(input: GovernancePolicyInput): NormalizedGovernancePlan {
  const tier = input.tier;
  if (tier !== undefined && !isDelegationTier(tier)) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `tier must be one of ${DELEGATION_TIERS.join(", ")}`,
    );
  }
  const write = tier === undefined ? true : WRITE_DELEGATION_TIERS.has(tier);
  const rawScope = input.scope ?? [];
  if (!Array.isArray(rawScope)) {
    throw new DelegationControlError("INVALID_ARGUMENT", "scope must be a list of paths");
  }
  const scope = [...new Set(rawScope.map(normalizeScopePath))];
  const checks = normalizeChecks(input.checks);
  const acceptance = normalizeText(input.acceptance, "acceptance", MAX_ACCEPTANCE_CHARS);
  const maxLightScope = input.maxLightScopeEntries ?? DEFAULT_LIGHT_MAX_SCOPE_ENTRIES;

  if (tier === "light") {
    if (scope.length === 0) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "A light tier delegation must declare the files it may change (--scope)",
      );
    }
    if (scope.length > maxLightScope) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `A light tier delegation may declare at most ${maxLightScope} scope entries; use the deep tier for wider work`,
      );
    }
    if (scope.includes(".")) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        'A light tier delegation may not claim the whole repository ("."); use the deep tier',
      );
    }
    if (checks.length === 0) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "A light tier delegation must declare at least one check command (--check)",
      );
    }
  }
  if (tier === "deep" && scope.length === 0) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      'A deep tier delegation must declare its scope (use "." for the whole repository)',
    );
  }

  // An undeclared write scope audits as, and claims, the whole repository. This matches the
  // upstream behavior: a governed writer never runs beside another writer unnoticed.
  const effectiveScope = scope.length > 0 ? scope : ["."];
  const claimsScope = write;

  if (write && input.sourceRepoRoot && input.existingRecords?.length) {
    const targetRepo = normalizeRepoKey(input.sourceRepoRoot);
    for (const existing of input.existingRecords) {
      if (!existing.sourceRepoRoot || normalizeRepoKey(existing.sourceRepoRoot) !== targetRepo) {
        continue;
      }
      const retry =
        Boolean(input.requestId) &&
        existing.requestId === input.requestId &&
        (input.parentThreadId === undefined || existing.parentThreadId === input.parentThreadId);
      if (retry) continue;
      if (!holdsWriteScope(existing)) continue;
      const existingScope = existing.scope.length > 0 ? existing.scope : ["."];
      const overlap = scopesOverlap(effectiveScope, existingScope);
      if (overlap) {
        throw new DelegationControlError(
          "SCOPE_CONFLICT",
          `Scope "${overlap.left}" overlaps "${overlap.right}" claimed by Thread ${existing.threadId} (${existing.status}${
            existing.status === "completed" ? ", not yet applied or discarded" : ""
          })`,
          {
            conflictingThreadId: existing.threadId,
            left: overlap.left,
            right: overlap.right,
          },
        );
      }
    }
  }

  return {
    ...(tier ? { tier } : {}),
    write,
    scope: effectiveScope,
    claimsScope,
    checks,
    ...(acceptance ? { acceptance } : {}),
  };
}

/**
 * Formats governance rules appended to the delegated task prompt.
 * Only called when governance fields (`tier`, `scope`, `checks`, or `acceptance`) were requested.
 */
export function buildGovernedTaskPrompt(input: {
  task: string;
  tier?: DelegationTier;
  write: boolean;
  scope: readonly string[];
  checks: readonly string[];
  acceptance?: string;
  baseCommit?: string;
  isWorktree?: boolean;
  allowNestedDelegation?: boolean;
}): string {
  const lines = [input.task.trimEnd(), ""];
  if (input.acceptance) {
    lines.push("Acceptance criteria:", input.acceptance, "");
  }
  const header = input.tier
    ? `Delegation governance (${input.tier} tier):`
    : "Delegation governance:";
  lines.push(header);
  if (input.isWorktree) {
    const base = input.baseCommit ? ` from commit ${input.baseCommit.slice(0, 12)}` : "";
    lines.push(
      `- Work only inside the current directory. It is an isolated git worktree prepared for this delegation${base}.`,
      "- Do not commit, push, or create branches; the planner reviews your changes and applies or discards them.",
    );
  }
  if (input.write) {
    const scopeLabel = input.scope.includes(".") ? "the whole repository" : input.scope.join(", ");
    lines.push(
      `- Change only files covered by this scope: ${scopeLabel}. Changes outside it are reported as out of scope.`,
    );
  } else {
    lines.push("- This is a read-only review: do not create, modify, or delete any file.");
  }
  if (!input.allowNestedDelegation) {
    lines.push(
      `- Do not delegate this work to other agents: this Thread runs as a governed executor (${DELEGATION_ROLE_ENV}=${DELEGATION_EXECUTOR_ROLE}).`,
    );
  }
  if (input.checks.length > 0) {
    lines.push(
      `- After you finish, codexhost verifies these checks in your workspace: ${input.checks.map((command) => `\`${command}\``).join(", ")}. Run them yourself first if you can.`,
    );
  }
  lines.push(
    "- Finish with a short summary: what you changed, how you verified it, and anything left undone.",
  );
  return lines.join("\n");
}
