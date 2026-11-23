import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStreamRedactor } from "../src/delegation-checks.js";
import {
  collectWorktreeChanges,
  verifyGovernedThread,
} from "../src/delegation-worktree-lifecycle.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { DelegationGovernanceStore } from "../src/delegation-governance-store.js";
import { DELEGATION_EXECUTOR_ROLE } from "../src/delegation-policy.js";
import { DelegationControlError } from "../src/delegation-types.js";
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

  it("disambiguates a base-like filename and rejects an unsafe baseline before staging", async () => {
    const worktree = path.join(temporary, "collect");
    await mkdir(path.join(temporary, "repo.worktrees"), { recursive: true });
    await git("worktree", "add", "-b", "collect", worktree);
    const base = await git("rev-parse", "HEAD");
    await writeFile(path.join(worktree, base), "same-name\n");
    await writeFile(path.join(worktree, "src", "a.txt"), "changed\n");

    const collected = await collectWorktreeChanges(worktree, base);
    expect(collected.files).toEqual(expect.arrayContaining(["src/a.txt", base]));

    const marker = path.join(worktree, "marker.txt");
    await writeFile(marker, "marker\n");
    await expect(collectWorktreeChanges(worktree, "--output=x")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(await readFile(marker, "utf8")).toBe("marker\n");
  });

  it("redacts sensitive values even when split across streaming output chunks or sharing prefixes", () => {
    const redactor = createStreamRedactor(["super-secret-token-123"]);
    const out =
      redactor.push(Buffer.from("prefix super-sec", "utf8")) +
      redactor.push(Buffer.from("ret-token-123 suffix", "utf8")) +
      redactor.end();
    expect(out).toBe("prefix [redacted] suffix");

    // Overlapping prefix secrets split across chunks must match longest-first without leaking suffixes.
    const prefixRedactor = createStreamRedactor(["secret123456", "secret12"]);
    const prefixOut =
      prefixRedactor.push(Buffer.from("foo secret12", "utf8")) +
      prefixRedactor.push(Buffer.from("3456 bar", "utf8")) +
      prefixRedactor.end();
    expect(prefixOut).toBe("foo [redacted] bar");
  });

  it("excludes check-generated artifacts from collected patch and out-of-scope audit, overwrites check logs, and redacts secrets", async () => {
    const fake = createFakeRegistration();
    const governanceStore = new DelegationGovernanceStore(path.join(dataDir, "jobs"));
    const secretValue = "sk-live-super-secret-value-999";
    const runtimeToken = "runtime-control-token-888";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEXHOST_DATA_DIR: dataDir,
      CODEXHOST_RUNTIME_TOKEN: runtimeToken,
      TEST_API_KEY: secretValue,
    };
    const registry = new DelegationControlRegistry({ governanceStore, environment: env });
    registry.register(fake.registration, { harnessCatalog: true });
    const server = await startDelegationControlServer({
      token: "secret",
      api: registry,
      watchApi: registry,
      governanceApi: registry,
    });
    const post = async (route: string, body: Record<string, unknown>) => {
      const response = await fetch(new URL(route, server.endpoint), {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    try {
      const checkScript =
        "node -e \"const fs=require('node:fs'); fs.writeFileSync('check-output.log','noise\\n'); console.log('key=' + process.env.TEST_API_KEY + ' token=' + String(process.env.CODEXHOST_RUNTIME_TOKEN));\"";
      const started = await post("/v1/delegate/start", {
        tier: "light",
        task: "Edit src/a.txt",
        parentThreadId: "planner-claude",
        cwd: repository,
        worktree: "feat/check-artifacts",
        scope: ["src/a.txt"],
        checks: [checkScript],
      });
      expect(started.status).toBe(200);
      const childId = String(started.body.threadId);
      const worktree = started.body.worktree as { path: string };
      await writeFile(path.join(worktree.path, "src", "a.txt"), "clean edit\n");
      fake.statuses.set(childId, "completed");

      const firstVerify = await post("/v1/thread/verify", { threadId: childId });
      expect(firstVerify.status).toBe(200);
      expect(firstVerify.body.verification).toBe("passed");
      expect(firstVerify.body.changedFiles).toEqual(["src/a.txt"]);
      expect(firstVerify.body.outOfScope).toEqual([]);
      const checkLog = (firstVerify.body.checks as Array<{ log?: string; summary: string }>)[0];
      expect(checkLog?.summary).not.toContain(secretValue);
      expect(checkLog?.summary).toContain("[redacted]");
      expect(checkLog?.summary).toContain("token=undefined");
      const logContent1 = await readFile(String(checkLog?.log), "utf8");
      expect(logContent1).not.toContain(secretValue);
      expect(logContent1).toContain("[redacted]");
      expect(logContent1).toContain("token=undefined");

      // Re-running verify overwrites the check log instead of appending AND excludes check-generated
      // artifacts automatically without mutating the worktree's real Git index.
      const secondVerify = await post("/v1/thread/verify", { threadId: childId });
      expect(secondVerify.status).toBe(200);
      expect(secondVerify.body.changedFiles).toEqual(["src/a.txt"]);
      expect(secondVerify.body.outOfScope).toEqual([]);
      const logContent2 = await readFile(String(checkLog?.log), "utf8");
      expect(logContent2.trim().split(/\r?\n/u)).toHaveLength(1);
      const { stdout: staged } = await execFileAsync("git", [
        "-C",
        worktree.path,
        "diff",
        "--cached",
        "--name-only",
      ]);
      expect(staged.trim()).toBe("");

      const applied = await post("/v1/thread/apply", { threadId: childId });
      expect(applied.status).toBe(200);
      expect(await readFile(path.join(repository, "src", "a.txt"), "utf8")).toBe("clean edit\n");
      await expect(readFile(path.join(repository, "check-output.log"), "utf8")).rejects.toThrow();

      // Already-integrated threads reject verify, and missing threadId returns INVALID_ARGUMENT.
      const verifyApplied = await post("/v1/thread/verify", { threadId: childId });
      expect(verifyApplied.status).toBe(400);
      expect((verifyApplied.body.error as { code: string }).code).toBe("ALREADY_INTEGRATED");
      const missingId = await post("/v1/thread/verify", {});
      expect(missingId.status).toBe(400);
      expect((missingId.body.error as { code: string }).code).toBe("INVALID_ARGUMENT");
    } finally {
      registry.close();
      await server.close();
    }
  });

  it("rejects apply while running after thread send, forces re-verification before applying, and blocks send after apply or discard", async () => {
    const fake = createFakeRegistration();
    const governanceStore = new DelegationGovernanceStore(path.join(dataDir, "jobs"));
    const env = { ...process.env, CODEXHOST_DATA_DIR: dataDir };
    const registry = new DelegationControlRegistry({ governanceStore, environment: env });
    registry.register(fake.registration, { harnessCatalog: true });
    vi.mocked(fake.registration.send).mockImplementation(async ({ threadId }) => {
      fake.statuses.set(threadId, "running");
      return {
        threadId,
        turnId: "t2",
        harnessId: "codex",
        status: "running",
        next: { read: "read", wait: "wait" },
      };
    });

    const server = await startDelegationControlServer({
      token: "secret",
      api: registry,
      watchApi: registry,
      governanceApi: registry,
    });
    const post = async (route: string, body: Record<string, unknown>) => {
      const response = await fetch(new URL(route, server.endpoint), {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    try {
      const started = await post("/v1/delegate/start", {
        tier: "deep",
        task: "Change a.txt",
        parentThreadId: "planner-claude",
        cwd: repository,
        worktree: "feat/resend-apply",
        scope: ["src/a.txt"],
      });
      expect(started.status).toBe(200);
      const childId = String(started.body.threadId);
      const worktree = started.body.worktree as { path: string };
      await writeFile(path.join(worktree.path, "src", "a.txt"), "first attempt\n");
      fake.statuses.set(childId, "completed");

      expect((await post("/v1/thread/verify", { threadId: childId })).status).toBe(200);
      expect(governanceStore.get(childId)?.verifiedAt).toBeDefined();

      // Send follow-up instructions; verification state is cleared and status resets to running.
      const resent = await post("/v1/thread/send", { threadId: childId, message: "revise to v2" });
      expect(resent.status).toBe(200);
      expect(governanceStore.get(childId)?.verifiedAt).toBeUndefined();
      expect(governanceStore.get(childId)?.patchPath).toBeUndefined();
      expect(governanceStore.get(childId)?.status).toBe("running");

      // Apply while running is rejected with THREAD_BUSY and worktree remains intact.
      const busyApply = await post("/v1/thread/apply", { threadId: childId });
      expect(busyApply.status).toBe(400);
      expect((busyApply.body.error as { code: string }).code).toBe("THREAD_BUSY");
      expect(await readFile(path.join(worktree.path, "src", "a.txt"), "utf8")).toBe(
        "first attempt\n",
      );

      // Child finishes revised edit; direct apply forces re-verification and lands revised edit.
      await writeFile(path.join(worktree.path, "src", "a.txt"), "revised v2\n");
      fake.statuses.set(childId, "completed");
      const applied = await post("/v1/thread/apply", { threadId: childId });
      expect(applied.status).toBe(200);
      expect(await readFile(path.join(repository, "src", "a.txt"), "utf8")).toBe("revised v2\n");

      // Send after apply is rejected with ALREADY_INTEGRATED.
      const afterApply = await post("/v1/thread/send", { threadId: childId, message: "more" });
      expect(afterApply.status).toBe(400);
      expect((afterApply.body.error as { code: string }).code).toBe("ALREADY_INTEGRATED");

      // Start a second thread, discard it, and verify send after discard is also rejected.
      const second = await post("/v1/delegate/start", {
        tier: "deep",
        task: "Discard target",
        parentThreadId: "planner-claude",
        cwd: repository,
        worktree: "feat/discard-send",
        scope: ["src/b.txt"],
      });
      const secondId = String(second.body.threadId);
      fake.statuses.set(secondId, "completed");
      expect((await post("/v1/thread/discard", { threadId: secondId })).status).toBe(200);
      const afterDiscard = await post("/v1/thread/send", { threadId: secondId, message: "more" });
      expect(afterDiscard.status).toBe(400);
      expect((afterDiscard.body.error as { code: string }).code).toBe("ALREADY_INTEGRATED");
    } finally {
      registry.close();
      await server.close();
    }
  });

  it("does not block unrelated delegate start during slow session open or slow verify, and serializes concurrent verify on the same thread", async () => {
    const fake = createFakeRegistration();
    const governanceStore = new DelegationGovernanceStore(path.join(dataDir, "jobs"));
    const env = { ...process.env, CODEXHOST_DATA_DIR: dataDir };
    const registry = new DelegationControlRegistry({ governanceStore, environment: env });
    registry.register(fake.registration, { harnessCatalog: true });

    // 1. Slow registration.start() on scope A does not block disjoint scope B, but still rejects overlapping scope C immediately.
    const slowOpenGate = Promise.withResolvers<undefined>();
    const slowOpenEntered = Promise.withResolvers<undefined>();
    const originalStart = fake.registration.start;
    let openCalls = 0;
    fake.registration.start = vi.fn(async (input) => {
      openCalls += 1;
      if (openCalls === 1) {
        slowOpenEntered.resolve(undefined);
        await slowOpenGate.promise;
      }
      return originalStart(input);
    });

    const firstStart = registry.start({
      tier: "deep",
      harnessId: "codex",
      task: "slow A",
      parentThreadId: "planner-claude",
      cwd: repository,
      scope: ["src/a.txt"],
    });
    await slowOpenEntered.promise;

    // Overlapping start fails immediately against pending claim without waiting for slowOpenGate.
    await expect(
      registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "overlap A",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["src/a.txt"],
      }),
    ).rejects.toMatchObject({ code: "SCOPE_CONFLICT" });

    // Disjoint start finishes completely while slow A is still opening its session!
    const disjoint = await registry.start({
      tier: "deep",
      harnessId: "codex",
      task: "fast B",
      parentThreadId: "planner-claude",
      cwd: repository,
      scope: ["src/b.txt"],
    });
    expect(disjoint.threadId).toBeDefined();

    slowOpenGate.resolve(undefined);
    const firstDone = await firstStart;
    expect(firstDone.threadId).toBeDefined();

    // 2. Slow verify on one thread does not block unrelated starts, and concurrent verify on the same thread serializes.
    fake.statuses.set(firstDone.threadId, "completed");
    fake.statuses.set(disjoint.threadId, "completed");

    const slowCheck = `node -e "setTimeout(() => process.exit(0), 350)"`;
    governanceStore.update(firstDone.threadId, (draft) => {
      draft.checks = [slowCheck];
    });
    let concurrentVerifyActive = 0;
    let maxVerifyConcurrency = 0;
    const origRead = fake.registration.read;
    fake.registration.read = vi.fn(async (input) => {
      if (input.threadId === firstDone.threadId) {
        concurrentVerifyActive += 1;
        maxVerifyConcurrency = Math.max(maxVerifyConcurrency, concurrentVerifyActive);
        try {
          return await origRead(input);
        } finally {
          concurrentVerifyActive -= 1;
        }
      }
      return origRead(input);
    });

    const verify1 = registry.verifyThread({ threadId: firstDone.threadId });
    const verify2 = registry.verifyThread({ threadId: firstDone.threadId });

    const unrelatedStartTime = Date.now();
    const unrelated = await registry.start({
      tier: "review",
      harnessId: "codex",
      task: "review while verifying",
      parentThreadId: "planner-claude",
      cwd: repository,
    });
    const unrelatedElapsed = Date.now() - unrelatedStartTime;
    expect(unrelated.threadId).toBeDefined();
    expect(unrelatedElapsed).toBeLessThan(300);

    const [v1, v2] = await Promise.all([verify1, verify2]);
    expect(v1.verification).toBe("passed");
    expect(v2.verification).toBe("passed");
    expect(maxVerifyConcurrency).toBe(1);
    registry.close();
  });

  it("refreshes stale live non-worktree records before SCOPE_CONFLICT, recovers from verify failures without sticking in verifying, and passes explicit scope in routingSet", async () => {
    const fake = createFakeRegistration();
    const governanceStore = new DelegationGovernanceStore(path.join(dataDir, "jobs"));
    const env = { ...process.env, CODEXHOST_DATA_DIR: dataDir };
    const registry = new DelegationControlRegistry({ governanceStore, environment: env });
    registry.register(fake.registration, { harnessCatalog: true });

    try {
      // Non-worktree write task completes without any caller invoking thread read.
      const first = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "direct edit",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["src/a.txt"],
      });
      expect(governanceStore.get(first.threadId)?.status).toBe("running");

      // While still running, overlapping start conflicts.
      await expect(
        registry.start({
          tier: "deep",
          harnessId: "codex",
          task: "blocked edit",
          parentThreadId: "planner-claude",
          cwd: repository,
          scope: ["src/a.txt"],
        }),
      ).rejects.toMatchObject({ code: "SCOPE_CONFLICT" });

      // Mark completed in Harness without reading; second start refreshes stale record and succeeds!
      fake.statuses.set(first.threadId, "completed");
      const second = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "after refresh",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["src/a.txt"],
      });
      expect(second.threadId).toBeDefined();
      expect(governanceStore.get(first.threadId)?.status).toBe("completed");

      // Legacy stuck "verifying" status also refreshes cleanly when real thread is terminal.
      governanceStore.update(second.threadId, (draft) => {
        draft.status = "verifying";
      });
      fake.statuses.set(second.threadId, "completed");
      const third = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "after legacy verifying",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["src/a.txt"],
      });
      expect(third.threadId).toBeDefined();
      expect(governanceStore.get(second.threadId)?.status).toBe("completed");

      // Verify failure (e.g. missing workspace) never leaves record persisted as "verifying".
      fake.statuses.set(third.threadId, "completed");
      governanceStore.update(third.threadId, (draft) => {
        draft.sourceRepoRoot = path.join(temporary, "gone-workspace");
      });
      await expect(registry.verifyThread({ threadId: third.threadId })).rejects.toMatchObject({
        code: "UNSUPPORTED",
      });
      expect(governanceStore.get(third.threadId)?.status).not.toBe("verifying");

      // Registry routingSet passes explicit scope: project checks.shell is rejected, user succeeds,
      // and user:false outside Git fails with INVALID_ARGUMENT instead of mutating user config.
      await expect(
        registry.routingSet({
          key: "checks.shell",
          value: "/bin/sh",
          cwd: repository,
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(
        registry.routingSet({
          key: "checks.timeoutMinutes",
          value: "15",
          cwd: temporary,
          user: false,
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      const userShell = await registry.routingSet({
        key: "checks.shell",
        value: "/bin/sh",
        cwd: repository,
        user: true,
      });
      expect(userShell.value).toBe("/bin/sh");

      // Resuming a stopped non-worktree governed writer checks scope conflicts against active writers.
      const writerA = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "writer A",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["src/b.txt"],
      });
      fake.statuses.set(writerA.threadId, "completed");
      const writerB = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "writer B",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["src/b.txt"],
      });
      expect(writerB.threadId).toBeDefined();
      await expect(
        registry.send({ threadId: writerA.threadId, message: "resume concurrently" }),
      ).rejects.toMatchObject({ code: "SCOPE_CONFLICT", details: { notStarted: true } });

      // Idempotent start retry returning an existing applied Thread preserves its governance record.
      const dedupStart = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "idempotent",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["docs"],
        requestId: "req-preserve",
      });
      governanceStore.update(dedupStart.threadId, (draft) => {
        draft.integration = "applied";
        draft.appliedAt = "2026-11-22T00:00:00.000Z";
      });
      vi.mocked(fake.registration.start).mockResolvedValueOnce({
        delegationId: "del-dup",
        threadId: dedupStart.threadId,
        turnId: "turn-dup",
        harnessId: "codex",
        deepLink: `codex://threads/${dedupStart.threadId}`,
        status: "running",
        cwd: repository,
        parentThreadId: "planner-claude",
        next: { read: "read", wait: "wait" },
      });
      const retried = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "idempotent",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["docs"],
        requestId: "req-preserve",
      });
      expect(retried.governance?.integration).toBe("applied");
      expect(governanceStore.get(dedupStart.threadId)?.integration).toBe("applied");
    } finally {
      registry.close();
    }
  });

  it("keeps a sent Thread running when a read races the send window", async () => {
    const fake = createFakeRegistration();
    const governanceStore = new DelegationGovernanceStore(path.join(dataDir, "jobs"));
    const registry = new DelegationControlRegistry({
      governanceStore,
      environment: { ...process.env, CODEXHOST_DATA_DIR: dataDir },
    });
    registry.register(fake.registration, { harnessCatalog: true });
    try {
      const started = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "send race",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["src/a.txt"],
      });
      fake.statuses.set(started.threadId, "completed");
      await registry.read({ threadId: started.threadId, view: "result" });
      expect(governanceStore.get(started.threadId)?.status).toBe("completed");

      const gate = Promise.withResolvers<undefined>();
      const entered = Promise.withResolvers<undefined>();
      fake.registration.send = vi.fn(async (input) => {
        entered.resolve(undefined);
        await gate.promise;
        fake.statuses.set(input.threadId, "running");
        return {
          threadId: input.threadId,
          turnId: "follow-up",
          harnessId: "codex" as const,
          status: "running" as const,
          next: { read: "read", wait: "wait" },
        };
      });
      const sending = registry.send({ threadId: started.threadId, message: "follow-up" });
      await entered.promise;
      // A read in the send window must not flash the record back to completed.
      await registry.read({ threadId: started.threadId, view: "result" });
      gate.resolve(undefined);
      await sending;
      expect(governanceStore.get(started.threadId)?.status).toBe("running");
    } finally {
      registry.close();
    }
  });

  it("does not leave a failed send marked running", async () => {
    const fake = createFakeRegistration();
    const governanceStore = new DelegationGovernanceStore(path.join(dataDir, "jobs"));
    const registry = new DelegationControlRegistry({
      governanceStore,
      environment: { ...process.env, CODEXHOST_DATA_DIR: dataDir },
    });
    registry.register(fake.registration, { harnessCatalog: true });
    try {
      const started = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "failed send",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["src/a.txt"],
      });
      fake.statuses.set(started.threadId, "completed");
      await registry.read({ threadId: started.threadId, view: "result" });
      fake.registration.send = vi.fn(async () => {
        throw new DelegationControlError("THREAD_BUSY", "target is busy");
      });
      await expect(
        registry.send({ threadId: started.threadId, message: "follow-up" }),
      ).rejects.toMatchObject({ code: "THREAD_BUSY" });
      expect(governanceStore.get(started.threadId)?.status).toBe("completed");
    } finally {
      registry.close();
    }
  });

  it("accepts a requestId retry without an explicit parent", async () => {
    const fake = createFakeRegistration();
    const governanceStore = new DelegationGovernanceStore(path.join(dataDir, "jobs"));
    const registry = new DelegationControlRegistry({
      governanceStore,
      environment: { ...process.env, CODEXHOST_DATA_DIR: dataDir },
    });
    registry.register(fake.registration, { harnessCatalog: true });
    try {
      const first = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "retry",
        cwd: repository,
        scope: ["src/a.txt"],
        requestId: "no-parent-retry",
      });
      expect(first.threadId).toBeDefined();
      const second = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "retry",
        cwd: repository,
        scope: ["src/a.txt"],
        requestId: "no-parent-retry",
      });
      expect(second.threadId).toBeDefined();
    } finally {
      registry.close();
    }
  });

  it("returns a warning when a user routing write succeeds but project config is invalid", async () => {
    const fake = createFakeRegistration();
    const governanceStore = new DelegationGovernanceStore(path.join(dataDir, "jobs"));
    const registry = new DelegationControlRegistry({
      governanceStore,
      environment: { ...process.env, CODEXHOST_DATA_DIR: dataDir },
    });
    registry.register(fake.registration, { harnessCatalog: true });
    try {
      await mkdir(path.join(repository, ".codexhost"), { recursive: true });
      await writeFile(
        path.join(repository, ".codexhost", "delegation-routing.json"),
        "{ invalid json\n",
        "utf8",
      );
      const result = await registry.routingSet({
        key: "checks.timeoutMinutes",
        value: "15",
        cwd: repository,
        user: true,
      });
      expect(result.warning).toContain("invalid");
      expect(result.routing).toBeUndefined();
    } finally {
      registry.close();
    }
  });

  it("reuses a same-turn patch when re-verifying", async () => {
    const worktree = path.join(temporary, "reuse");
    await mkdir(path.join(temporary, "repo.worktrees"), { recursive: true });
    await git("worktree", "add", "-b", "reuse", worktree);
    const base = await git("rev-parse", "HEAD");
    await writeFile(path.join(worktree, "src", "a.txt"), "executor edit\n");
    const governanceStore = new DelegationGovernanceStore(path.join(dataDir, "reuse-jobs"));
    const now = new Date().toISOString();
    governanceStore.save({
      formatVersion: 1,
      threadId: "reuse-thread",
      harnessId: "codex",
      write: true,
      allowNestedDelegation: false,
      scope: ["src/a.txt"],
      checks: ["node -e \"require('fs').appendFileSync('src/a.txt','checked')\""],
      sourceRepoRoot: repository,
      worktree: { path: worktree, branch: "reuse", base },
      status: "running",
      integration: "none",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    });
    const api = {
      read: vi.fn(async () => ({
        threadId: "reuse-thread",
        harnessId: "codex" as const,
        status: "completed" as const,
        turn: { turnId: "turn-1", status: "completed" as const },
        progress: [],
        result: { availability: "available" as const, text: "done" },
      })),
    };
    const first = await verifyGovernedThread({
      threadId: "reuse-thread",
      api: api as never,
      store: governanceStore,
    });
    expect(first.patchPath).toBeDefined();
    const patchBefore = await readFile(String(first.patchPath), "utf8");
    const second = await verifyGovernedThread({
      threadId: "reuse-thread",
      api: api as never,
      store: governanceStore,
    });
    expect(second.changedFiles).toEqual(first.changedFiles);
    expect(await readFile(String(second.patchPath), "utf8")).toBe(patchBefore);
  });

  it("does not delete executor files when untracked listing fails", async () => {
    const worktree = path.join(temporary, "untracked-failure");
    await mkdir(path.join(temporary, "repo.worktrees"), { recursive: true });
    await git("worktree", "add", "-b", "untracked-failure", worktree);
    const base = await git("rev-parse", "HEAD");
    await writeFile(path.join(worktree, "src", "a.txt"), "executor edit\n");
    const index = await git(
      "-C",
      worktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    );
    await writeFile(index, "not a valid git index\n", "utf8");
    const governanceStore = new DelegationGovernanceStore(path.join(dataDir, "untracked-jobs"));
    const now = new Date().toISOString();
    governanceStore.save({
      formatVersion: 1,
      threadId: "untracked-thread",
      harnessId: "codex",
      write: true,
      allowNestedDelegation: false,
      scope: ["src/a.txt"],
      checks: ["node -e \"require('fs').writeFileSync('check-created.txt','x')\""],
      sourceRepoRoot: repository,
      worktree: { path: worktree, branch: "untracked-failure", base },
      status: "running",
      integration: "none",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    });
    const api = {
      read: vi.fn(async () => ({
        threadId: "untracked-thread",
        harnessId: "codex" as const,
        status: "completed" as const,
        turn: { turnId: "turn-untracked", status: "completed" as const },
        progress: [],
        result: { availability: "available" as const, text: "done" },
      })),
    };
    await verifyGovernedThread({
      threadId: "untracked-thread",
      api: api as never,
      store: governanceStore,
    });
    await expect(readFile(path.join(worktree, "check-created.txt"), "utf8")).resolves.toBe("x");
  });

  it("refreshes a legacy verifying record through read and releases its lock", async () => {
    const fake = createFakeRegistration();
    const governanceStore = new DelegationGovernanceStore(path.join(dataDir, "jobs"));
    const registry = new DelegationControlRegistry({
      governanceStore,
      environment: { ...process.env, CODEXHOST_DATA_DIR: dataDir },
    });
    registry.register(fake.registration, { harnessCatalog: true });
    try {
      const first = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "legacy verifying",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["src/a.txt"],
      });
      governanceStore.update(first.threadId, (draft) => {
        draft.status = "verifying";
      });
      fake.statuses.set(first.threadId, "completed");
      expect((await registry.read({ threadId: first.threadId, view: "result" })).status).toBe(
        "completed",
      );
      expect(governanceStore.get(first.threadId)?.status).toBe("completed");
      const second = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "after legacy verifying read",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["src/a.txt"],
      });
      expect(second.threadId).toBeDefined();
    } finally {
      registry.close();
    }
  });

  it("marks a vanished live writer interrupted so another delegation can claim its scope", async () => {
    const fake = createFakeRegistration();
    const governanceStore = new DelegationGovernanceStore(path.join(dataDir, "jobs"));
    const registry = new DelegationControlRegistry({
      governanceStore,
      environment: { ...process.env, CODEXHOST_DATA_DIR: dataDir },
    });
    registry.register(fake.registration, { harnessCatalog: true });
    try {
      const first = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "vanished",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["src/a.txt"],
      });
      const defaultRead = fake.registration.read;
      fake.registration.read = vi.fn(async (input) => {
        if (input.threadId === first.threadId)
          throw new DelegationControlError("THREAD_NOT_FOUND", "gone");
        return defaultRead(input);
      });

      const second = await registry.start({
        tier: "deep",
        harnessId: "codex",
        task: "replacement",
        parentThreadId: "planner-claude",
        cwd: repository,
        scope: ["src/a.txt"],
      });
      expect(second.threadId).toBeDefined();
      expect(governanceStore.get(first.threadId)?.status).toBe("interrupted");
    } finally {
      registry.close();
    }
  });
});
