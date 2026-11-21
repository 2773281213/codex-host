import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStreamRedactor } from "../src/delegation-checks.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { DelegationGovernanceStore } from "../src/delegation-governance-store.js";
import { DELEGATION_EXECUTOR_ROLE } from "../src/delegation-policy.js";
import type {
  DelegationControlRegistration,
  DelegationStartInput,
  DelegationThreadSnapshot,
  DelegationThreadStatus,
} from "../src/delegation-types.js";

const execFileAsync = promisify(execFile);
let temporary: string;
let repository: string;
let dataDir: string;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args]);
  return stdout.trim();
}

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "delegation-lifecycle-")));
  repository = path.join(temporary, "repo");
  dataDir = path.join(temporary, "data");
  await mkdir(repository, { recursive: true });
  await mkdir(path.join(repository, "src"), { recursive: true });
  await git("init", "-b", "main");
  await git("config", "user.name", "Lifecycle Test");
  await git("config", "user.email", "lifecycle@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.autocrlf", "false");
  await git("config", "core.hooksPath", path.join(temporary, "no-hooks"));
  await writeFile(path.join(repository, "src", "a.txt"), "v1\n");
  await writeFile(path.join(repository, "src", "b.txt"), "b1\n");
  await git("add", ".");
  await git("commit", "-m", "initial");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(temporary, { recursive: true, force: true });
});

function createFakeRegistration() {
  const statuses = new Map<string, DelegationThreadStatus>([["planner-claude", "running"]]);
  const harnesses = new Map<string, string>([["planner-claude", "claude-code"]]);
  const started: DelegationStartInput[] = [];
  let counter = 0;

  const registration: DelegationControlRegistration = {
    listHarnesses: vi.fn(async () => ({
      harnesses: ["codex", "claude-code", "deepseek-harness"],
    })),
    inspect: vi.fn(async ({ harnessId }) => ({
      harnessId,
      inspection: { status: "unavailable", message: "mock" },
    })) as unknown as DelegationControlRegistration["inspect"],
    start: vi.fn(async (input) => {
      started.push(input);
      counter += 1;
      const threadId = `child-${counter}`;
      statuses.set(threadId, "running");
      harnesses.set(threadId, input.harnessId);
      return {
        delegationId: `del-${counter}`,
        threadId,
        turnId: `turn-${counter}`,
        harnessId: input.harnessId,
        deepLink: `codex://threads/${threadId}`,
        status: "running" as const,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
        next: { read: "read", wait: "wait" },
      };
    }),
    send: vi.fn(async () => ({
      threadId: "child-1",
      turnId: "t2",
      harnessId: "codex" as DelegationThreadSnapshot["harnessId"],
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    })),
    cancel: vi.fn(async ({ threadId }) => {
      statuses.set(threadId, "interrupted");
      return {
        threadId,
        turnId: "t1",
        harnessId: (harnesses.get(threadId) ?? "codex") as DelegationThreadSnapshot["harnessId"],
        cancelled: true,
      };
    }),
    read: vi.fn(async ({ threadId }) => ({
      threadId,
      harnessId: (harnesses.get(threadId) ?? "codex") as DelegationThreadSnapshot["harnessId"],
      status: statuses.get(threadId) ?? "completed",
      turn: { turnId: "t1", status: statuses.get(threadId) ?? "completed" },
      progress: [],
      result: { availability: "available" as const, text: "done" },
    })),
    wait: vi.fn(async ({ threadId }) => ({
      threadId,
      harnessId: (harnesses.get(threadId) ?? "codex") as DelegationThreadSnapshot["harnessId"],
      status: statuses.get(threadId) ?? "completed",
      turn: { turnId: "t1", status: statuses.get(threadId) ?? "completed" },
      progress: [],
      result: { availability: "available" as const, text: "done" },
      timedOut: false,
    })),
    answer: vi.fn(async () => {
      throw new Error("unused");
    }),
    list: vi.fn(async () => ({ threads: [], nextCursor: null })),
    canHandleStart: () => true,
    ownsThread: (id) => statuses.has(id),
  };

  return { registration, statuses, started };
}

describe("governed worktree lifecycle (verify, out-of-scope audit, apply, discard)", () => {
  it("snapshots uncommitted edits, enforces scope locks & anti-recursion, verifies checks, and applies/discards cleanly", async () => {
    const fake = createFakeRegistration();
    const governanceStore = new DelegationGovernanceStore(path.join(dataDir, "jobs"));
    const env = { ...process.env, CODEXHOST_DATA_DIR: dataDir };
    const registry = new DelegationControlRegistry({ governanceStore, environment: env });
    registry.register(fake.registration, { harnessCatalog: true });

    const server = await startDelegationControlServer({
      token: "secret",
      api: registry,
      watchApi: registry,
      governanceApi: registry,
    });

    async function post(route: string, body: Record<string, unknown>) {
      const response = await fetch(new URL(route, server.endpoint), {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }

    try {
      // Create an uncommitted tracked change + an untracked file in source repo.
      await writeFile(path.join(repository, "src", "a.txt"), "v1-uncommitted\n");
      await writeFile(path.join(repository, "scratch.tmp"), "untracked\n");

      // Dispatch light tier without explicit harness: Claude Code planner -> deepseek-harness.
      const started = await post("/v1/delegate/start", {
        tier: "light",
        task: "Update src/a.txt",
        parentThreadId: "planner-claude",
        cwd: repository,
        worktree: "feat/light-a",
        includeUncommitted: true,
        scope: ["src/a.txt"],
        checks: ['node -e "process.exit(0)"'],
      });
      expect(started.status).toBe(200);
      expect(started.body.harnessId).toBe("deepseek-harness");
      const worktree = started.body.worktree as {
        path: string;
        branch: string;
        base: string;
        includesUncommitted: boolean;
        untrackedCount: number;
      };
      expect(worktree.includesUncommitted).toBe(true);
      expect(worktree.untrackedCount).toBe(1);
      // Baseline inside worktree contains the uncommitted edit!
      expect(await readFile(path.join(worktree.path, "src", "a.txt"), "utf8")).toBe(
        "v1-uncommitted\n",
      );
      expect(fake.started[0]?.allowNestedDelegation).toBe(false);
      expect(fake.started[0]?.task).toContain("CODEXHOST_DELEGATION_ROLE=executor");

      const childId = String(started.body.threadId);

      // Overlapping write delegation is rejected with SCOPE_CONFLICT.
      const overlap = await post("/v1/delegate/start", {
        tier: "deep",
        task: "Overlap src",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["src"],
      });
      expect(overlap.status).toBe(400);
      expect((overlap.body.error as { code: string }).code).toBe("SCOPE_CONFLICT");

      // Recursive delegation from executor Thread or role is rejected.
      const recursive = await post("/v1/delegate/start", {
        harnessId: "codex",
        task: "Nested",
        parentThreadId: childId,
        cwd: repository,
      });
      expect(recursive.status).toBe(400);
      expect((recursive.body.error as { code: string }).code).toBe("EXECUTOR_ROLE_FORBIDDEN");

      const roleBlocked = await post("/v1/delegate/start", {
        harnessId: "codex",
        task: "Nested by env",
        callerRole: DELEGATION_EXECUTOR_ROLE,
        parentThreadId: "planner-claude",
        cwd: repository,
      });
      expect(roleBlocked.status).toBe(400);
      expect((roleBlocked.body.error as { code: string }).code).toBe("EXECUTOR_ROLE_FORBIDDEN");

      // Simulate executor modifying BOTH in-scope a.txt AND out-of-scope b.txt.
      await writeFile(path.join(worktree.path, "src", "a.txt"), "v1-uncommitted\nfrom-executor\n");
      await writeFile(path.join(worktree.path, "src", "b.txt"), "stray edit\n");

      // Verify refuses while running.
      const busyVerify = await post("/v1/thread/verify", { threadId: childId });
      expect(busyVerify.status).toBe(400);
      expect((busyVerify.body.error as { code: string }).code).toBe("THREAD_BUSY");

      // Complete executor and verify.
      fake.statuses.set(childId, "completed");
      const verified = await post("/v1/thread/verify", { threadId: childId });
      expect(verified.status).toBe(200);
      expect(verified.body.verification).toBe("passed");
      expect(verified.body.changedFiles).toEqual(["src/a.txt", "src/b.txt"]);
      expect(verified.body.outOfScope).toEqual(["src/b.txt"]);

      // Apply rejects out-of-scope changes unless allowOutOfScope=true.
      const blockedApply = await post("/v1/thread/apply", { threadId: childId });
      expect(blockedApply.status).toBe(400);
      expect((blockedApply.body.error as { code: string }).code).toBe("OUT_OF_SCOPE");

      // Applying with allowOutOfScope=true lands changes unstaged and removes worktree + releases scope lock.
      const applied = await post("/v1/thread/apply", {
        threadId: childId,
        allowOutOfScope: true,
      });
      expect(applied.status).toBe(200);
      expect(applied.body.applied).toBe(true);
      expect(applied.body.worktreeRemoved).toBe(true);
      expect(applied.body.branchRemoved).toBe(true);
      expect(await readFile(path.join(repository, "src", "a.txt"), "utf8")).toBe(
        "v1-uncommitted\nfrom-executor\n",
      );
      expect(await readFile(path.join(repository, "src", "b.txt"), "utf8")).toBe("stray edit\n");

      // Scope lock is now released: a new delegation claiming src/a.txt succeeds, and discard cleans it up.
      const next = await post("/v1/delegate/start", {
        tier: "light",
        task: "Follow-up failing check",
        parentThreadId: "planner-claude",
        cwd: repository,
        worktree: "feat/light-fail",
        scope: ["src/a.txt"],
        checks: ['node -e "process.exit(3)"'],
      });
      expect(next.status).toBe(200);
      const secondId = String(next.body.threadId);
      fake.statuses.set(secondId, "completed");

      const failedVerify = await post("/v1/thread/verify", { threadId: secondId });
      expect(failedVerify.status).toBe(200);
      expect(failedVerify.body.verification).toBe("failed");
      expect(failedVerify.body.status).toBe("failed");
      expect((failedVerify.body.checks as Array<{ exitCode: number }>)[0]?.exitCode).toBe(3);

      const refusedApply = await post("/v1/thread/apply", { threadId: secondId });
      expect(refusedApply.status).toBe(400);
      expect((refusedApply.body.error as { code: string }).code).toBe("CHECKS_FAILED");

      const discarded = await post("/v1/thread/discard", { threadId: secondId });
      expect(discarded.status).toBe(200);
      expect(discarded.body.discarded).toBe(true);
      expect(discarded.body.worktreeRemoved).toBe(true);
      expect(discarded.body.branchRemoved).toBe(true);
    } finally {
      registry.close();
      await server.close();
    }
  });

  it("redacts sensitive values even when split across streaming output chunks", () => {
    const redactor = createStreamRedactor(["super-secret-token-123"]);
    const out =
      redactor.push(Buffer.from("prefix super-sec", "utf8")) +
      redactor.push(Buffer.from("ret-token-123 suffix", "utf8")) +
      redactor.end();
    expect(out).toBe("prefix [redacted] suffix");
  });
});
