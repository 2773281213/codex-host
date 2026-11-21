import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { DelegationCheckResult, DelegationVerificationStatus } from "./delegation-checks.js";
import type { DelegationTier, ScopeHoldingRecord } from "./delegation-policy.js";
import { renameSyncWithRetry } from "./delegation-routing.js";
import type { DelegationThreadStatus } from "./delegation-types.js";
import type { DelegationWorktree } from "./delegation-worktree.js";
import { codexhostDataDirectory } from "./external-clients.js";

export type DelegationIntegrationState = "none" | "applied" | "discarded";

export interface DelegationGovernanceRecord extends ScopeHoldingRecord {
  formatVersion: 1;
  threadId: string;
  parentThreadId?: string;
  plannerHarnessId?: string;
  harnessId: string;
  tier?: DelegationTier;
  profile?: string;
  write: boolean;
  allowNestedDelegation: boolean;
  scope: string[];
  checks: string[];
  acceptance?: string;
  sourceRepoRoot?: string;
  worktree?: DelegationWorktree;
  status: DelegationThreadStatus | "verifying";
  integration: DelegationIntegrationState;
  verification?: DelegationVerificationStatus;
  checkResults?: DelegationCheckResult[];
  changedFiles?: string[];
  outOfScope?: string[];
  patchPath?: string;
  patchStat?: string;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  appliedAt?: string;
  discardedAt?: string;
}

export function defaultDelegationGovernanceDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(codexhostDataDirectory(environment), "delegation-jobs");
}

function recordKey(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex").slice(0, 32);
}

/**
 * Durable governance store for delegated Threads: scope claims, verification checks,
 * binary patches, out-of-scope audit results, and integration state (none/applied/discarded).
 * Serializes mutations in-process so concurrent dispatch scope-conflict checks cannot race.
 */
export class DelegationGovernanceStore {
  readonly #directory: string;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(directory: string) {
    this.#directory = directory;
  }

  get directory(): string {
    return this.#directory;
  }

  paths(threadId: string): { recordFile: string; patchFile: string; checksDir: string } {
    const key = recordKey(threadId);
    return {
      recordFile: path.join(this.#directory, `${key}.json`),
      patchFile: path.join(this.#directory, `${key}.patch`),
      checksDir: path.join(this.#directory, `${key}-checks`),
    };
  }

  /** Serializes critical sections such as scope-conflict checks + creation. */
  withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  get(threadId: string): DelegationGovernanceRecord | null {
    const file = this.paths(threadId).recordFile;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DelegationGovernanceRecord> | null;
      if (!parsed || parsed.formatVersion !== 1 || parsed.threadId !== threadId) return null;
      return parsed as DelegationGovernanceRecord;
    } catch {
      return null;
    }
  }

  list(): DelegationGovernanceRecord[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.#directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: DelegationGovernanceRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const fullPath = path.join(this.#directory, entry);
      try {
        const parsed = JSON.parse(
          fs.readFileSync(fullPath, "utf8"),
        ) as Partial<DelegationGovernanceRecord> | null;
        if (parsed && parsed.formatVersion === 1 && typeof parsed.threadId === "string") {
          records.push(parsed as DelegationGovernanceRecord);
        }
      } catch {
        /* ignore unreadable or transient entries */
      }
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  save(record: DelegationGovernanceRecord): DelegationGovernanceRecord {
    fs.mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const target = this.paths(record.threadId).recordFile;
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const copy: DelegationGovernanceRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(copy, null, 2)}\n`, { mode: 0o600 });
      renameSyncWithRetry(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return copy;
  }

  update(
    threadId: string,
    mutate: (draft: DelegationGovernanceRecord) => void,
  ): DelegationGovernanceRecord | null {
    const current = this.get(threadId);
    if (!current) return null;
    const draft = structuredClone(current);
    mutate(draft);
    return this.save(draft);
  }

  writePatch(threadId: string, patchText: string): string {
    fs.mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const target = this.paths(threadId).patchFile;
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, patchText, { mode: 0o600 });
      renameSyncWithRetry(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return target;
  }

  /** Whether a Thread was created as a governed executor that may not recursively delegate. */
  isExecutorThread(threadId: string): boolean {
    const record = this.get(threadId);
    return record !== null && !record.allowNestedDelegation;
  }
}
