import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { DelegationGovernanceStore } from "../src/delegation-governance-store.js";
import { DELEGATION_ROLE_ENV } from "../src/delegation-policy.js";
import { DelegationControlError } from "../src/delegation-types.js";
import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  type DelegationControlRegistration,
  type DelegationStartInput,
  type DelegationThreadSnapshot,
  type DelegationThreadStatus,
} from "../src/delegation-types.js";
import { removeWorktreeCheckout } from "../src/delegation-worktree-lifecycle.js";
import { externalClientRouter } from "../src/external-client-routes.js";

const execFileAsync = promisify(execFile);
const token = "governance-worktree-secret";

let temporary: string;
let repository: string;
let dataDir: string;
let store: DelegationGovernanceStore;
let registry: DelegationControlRegistry;
let server: Awaited<ReturnType<typeof startDelegationControlServer>>;
let fake: ReturnType<typeof createFakeRegistration>;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args]);
  return stdout.trim();
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function managedPath(branch: string): string {
  return path.join(temporary, "repo.worktrees", branch.replace(/[^a-zA-Z0-9._-]/gu, "-"));
}

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

async function post(route: string, body: Record<string, unknown>) {
  const response = await fetch(new URL(route, server.endpoint), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function invokeStart(args: string[], extraEnvironment: NodeJS.ProcessEnv = {}) {
  const output = new PassThrough();
  const diagnosticOutput = new PassThrough();
  const code = await runDelegationCli({
    arguments: ["delegate", "start", ...args],
    environment: {
      ...process.env,
      [DELEGATION_RUNTIME_ENDPOINT_ENV]: server.endpoint,
      [DELEGATION_RUNTIME_TOKEN_ENV]: token,
      ...extraEnvironment,
    },
    output,
    diagnosticOutput,
  });
  const outputText = output.read()?.toString().trim();
  const diagnosticText = diagnosticOutput.read()?.toString().trim();
  return { code, outputText, diagnosticText };
}

async function runStart(args: string[], extraEnvironment: NodeJS.ProcessEnv = {}) {
  const { code, outputText, diagnosticText } = await invokeStart(args, extraEnvironment);
  return {
    code,
    result: outputText ? (JSON.parse(outputText) as Record<string, unknown>) : undefined,
    error: diagnosticText
      ? ((JSON.parse(diagnosticText) as { error?: { code?: string; message?: string } }).error ??
        {})
      : undefined,
  };
}

function errorOf(body: Record<string, unknown>): { code?: string; message?: string } {
  return body.error as { code?: string; message?: string };
}

async function createLinkedWorktree(branch: string, target = managedPath(branch)): Promise<string> {
  await mkdir(path.dirname(target), { recursive: true });
  await git("worktree", "add", "-b", branch, target);
  return target;
}

function externalStartRoute() {
  const route = externalClientRouter({ api: registry, governanceApi: registry });
  const call = { client: "tester" } as Parameters<typeof route>[0];
  return (body: Record<string, unknown>) => route(call, "/v1/delegate/start", body);
}

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "delegation-governed-wt-")));
  repository = path.join(temporary, "repo");
  dataDir = path.join(temporary, "data");
  await mkdir(path.join(repository, "src"), { recursive: true });
  await git("init", "-b", "main");
  await git("config", "user.name", "Governance Worktree Test");
  await git("config", "user.email", "governance-worktree@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.autocrlf", "false");
  await git("config", "core.hooksPath", path.join(temporary, "no-hooks"));
  await writeFile(path.join(repository, "src", "a.txt"), "v1\n");
  await git("add", ".");
  await git("commit", "-m", "initial");

  fake = createFakeRegistration();
  store = new DelegationGovernanceStore(path.join(dataDir, "jobs"));
  registry = new DelegationControlRegistry({
    governanceStore: store,
    environment: { ...process.env, CODEXHOST_DATA_DIR: dataDir },
  });
  registry.register(fake.registration, { harnessCatalog: true });
  server = await startDelegationControlServer({
    token,
    api: registry,
    watchApi: registry,
    governanceApi: registry,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  registry.close();
  await server.close();
  await rm(temporary, { recursive: true, force: true });
});

describe("governed worktree starts over the real control server", () => {
  it("creates the governed worktree on the Host and applies CLI changes back to the source", async () => {
    const first = await runStart([
      "--tier",
      "deep",
      "--scope",
      "src",
      "--cwd",
      repository,
      "--worktree",
      "feat/x",
      "--parent-thread",
      "planner-claude",
      "--task",
      "change a",
    ]);
    expect({ code: first.code, error: first.error }).toEqual({ code: 0, error: undefined });
    const childId = String(first.result?.threadId);
    const worktreePath = managedPath("feat/x");
    expect(first.result?.worktree).toMatchObject({ path: worktreePath, branch: "feat/x" });
    expect(fake.started[0]?.cwd && path.resolve(fake.started[0].cwd)).toBe(
      path.resolve(worktreePath),
    );
    expect(fake.started[0]?.worktreeMetadata?.path).toBe(worktreePath);

    const record = store.get(childId);
    expect(record?.sourceRepoRoot && path.resolve(record.sourceRepoRoot)).toBe(
      path.resolve(repository),
    );
    expect(path.resolve(record?.worktree?.path ?? "")).toBe(path.resolve(worktreePath));

    const second = await runStart([
      "--tier",
      "deep",
      "--scope",
      "src/nested",
      "--cwd",
      repository,
      "--worktree",
      "feat/y",
      "--parent-thread",
      "planner-claude",
      "--task",
      "overlap",
    ]);
    expect(second.code).toBe(1);
    expect(second.error?.code).toBe("SCOPE_CONFLICT");
    expect(await exists(managedPath("feat/y"))).toBe(false);
    expect(await git("branch", "--list", "feat/y")).toBe("");

    await writeFile(path.join(worktreePath, "src", "a.txt"), "changed by executor\n");
    fake.statuses.set(childId, "completed");
    const verified = await post("/v1/thread/verify", { threadId: childId });
    expect(verified.status).toBe(200);
    expect(verified.body.changedFiles).toEqual(["src/a.txt"]);

    const applied = await post("/v1/thread/apply", { threadId: childId });
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(true);
    expect(await readFile(path.join(repository, "src", "a.txt"), "utf8")).toBe(
      "changed by executor\n",
    );
    expect(await exists(worktreePath)).toBe(false);
    expect(await git("branch", "--list", "feat/x")).toBe("");
  });

  it("keeps unrelated starts responsive while apply runs a slow check", async () => {
    const slowCheck =
      "node -e \"require('node:fs').writeFileSync('slow-start.txt','1'); setTimeout(() => {}, 1500)\"";
    const started = await post("/v1/delegate/start", {
      tier: "light",
      scope: ["src/a.txt"],
      checks: [slowCheck],
      task: "slow apply",
      parentThreadId: "planner-claude",
      cwd: repository,
      worktree: "slow-apply",
    });
    expect(started.status).toBe(200);
    const childId = String(started.body.threadId);
    const worktree = managedPath("slow-apply");
    await writeFile(path.join(worktree, "src", "a.txt"), "slow edit\n");
    fake.statuses.set(childId, "completed");

    const applying = post("/v1/thread/apply", { threadId: childId });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await exists(path.join(worktree, "slow-start.txt"))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const startedAt = Date.now();
    const disjoint = await post("/v1/delegate/start", {
      tier: "deep",
      scope: ["docs"],
      task: "while applying",
      parentThreadId: "planner-claude",
      cwd: repository,
    });
    expect(disjoint.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect((await applying).status).toBe(200);
  });

  it("reclaims a Host-created worktree when the in-lock scope claim fails", async () => {
    const originalStart = fake.registration.start;
    const gate = Promise.withResolvers<undefined>();
    const entered = Promise.withResolvers<undefined>();
    let starts = 0;
    fake.registration.start = vi.fn(async (input) => {
      starts += 1;
      if (starts === 1) {
        entered.resolve(undefined);
        await gate.promise;
      }
      return originalStart(input);
    });
    // Let both requests pass the pre-create check so the second conflicts inside the store lock.
    vi.spyOn(registry, "preflightStart").mockResolvedValue({ ok: true });

    const firstPromise = post("/v1/delegate/start", {
      tier: "deep",
      scope: ["src/a.txt"],
      task: "race first",
      parentThreadId: "planner-claude",
      cwd: repository,
      worktree: "race-first",
    });
    await entered.promise;
    const second = await post("/v1/delegate/start", {
      tier: "deep",
      scope: ["src/a.txt"],
      task: "race second",
      parentThreadId: "planner-claude",
      cwd: repository,
      worktree: "race-second",
    });
    expect(second.status).toBe(400);
    expect(errorOf(second.body).code).toBe("SCOPE_CONFLICT");
    expect(await exists(managedPath("race-second"))).toBe(false);
    expect(await git("branch", "--list", "race-second")).toBe("");

    gate.resolve(undefined);
    const first = await firstPromise;
    expect(first.status).toBe(200);
    expect(await exists(managedPath("race-first"))).toBe(true);
  });

  it("applies a governed worktree back to the planner's linked worktree", async () => {
    const plannerWorktree = path.join(temporary, "planner-worktree");
    await git("worktree", "add", "-b", "planner-base", plannerWorktree);

    const started = await runStart([
      "--tier",
      "deep",
      "--scope",
      "src",
      "--cwd",
      plannerWorktree,
      "--worktree",
      "feat/planner-child",
      "--parent-thread",
      "planner-claude",
      "--task",
      "planner change",
    ]);
    expect({ code: started.code, error: started.error }).toEqual({ code: 0, error: undefined });
    const childId = String(started.result?.threadId);
    const childWorktree = managedPath("feat/planner-child");
    const record = store.get(childId);
    expect(record?.sourceRepoRoot && path.resolve(record.sourceRepoRoot)).toBe(
      path.resolve(plannerWorktree),
    );

    await writeFile(path.join(childWorktree, "src", "a.txt"), "planner changed\n");
    fake.statuses.set(childId, "completed");
    expect((await post("/v1/thread/verify", { threadId: childId })).status).toBe(200);
    expect((await post("/v1/thread/apply", { threadId: childId })).status).toBe(200);
    expect(await readFile(path.join(plannerWorktree, "src", "a.txt"), "utf8")).toBe(
      "planner changed\n",
    );
    expect(await readFile(path.join(repository, "src", "a.txt"), "utf8")).toBe("v1\n");
  });

  it("returns the Host-created worktree in json, compact and text formats", async () => {
    const json = await runStart([
      "--tier",
      "deep",
      "--scope",
      "src",
      "--cwd",
      repository,
      "--worktree",
      "fmt-json",
      "--parent-thread",
      "planner-claude",
      "--task",
      "json",
      "--format",
      "json",
    ]);
    expect(json.result?.worktree).toMatchObject({ path: managedPath("fmt-json") });
    const jsonId = String(json.result?.threadId);
    fake.statuses.set(jsonId, "completed");
    expect((await post("/v1/thread/discard", { threadId: jsonId })).status).toBe(200);

    const compact = await runStart([
      "--tier",
      "deep",
      "--scope",
      "src",
      "--cwd",
      repository,
      "--worktree",
      "fmt-compact",
      "--parent-thread",
      "planner-claude",
      "--task",
      "compact",
      "--format",
      "compact",
    ]);
    expect(compact.result?.worktree).toMatchObject({ path: managedPath("fmt-compact") });
    const compactId = store
      .list()
      .find((record) => record.worktree?.branch === "fmt-compact")?.threadId;
    expect(compactId).toBeDefined();
    fake.statuses.set(String(compactId), "completed");
    expect((await post("/v1/thread/discard", { threadId: String(compactId) })).status).toBe(200);

    const text = await invokeStart([
      "--tier",
      "deep",
      "--scope",
      "src",
      "--cwd",
      repository,
      "--worktree",
      "fmt-text",
      "--parent-thread",
      "planner-claude",
      "--task",
      "text",
      "--format",
      "text",
    ]);
    expect(text.code).toBe(0);
    expect(text.outputText).toContain(`worktree.path: ${managedPath("fmt-text")}`);

    const plain = await invokeStart([
      "--harness",
      "codex",
      "--cwd",
      repository,
      "--worktree",
      "fmt-plain-text",
      "--task",
      "plain text",
      "--format",
      "text",
    ]);
    expect(plain.code).toBe(0);
    expect(plain.outputText).toContain(`worktree.path: ${managedPath("fmt-plain-text")}`);
  });

  it("runs two plain --worktree delegations without governance and reports them as ungoverned", async () => {
    const first = await runStart([
      "--harness",
      "codex",
      "--cwd",
      repository,
      "--worktree",
      "plain-one",
      "--task",
      "first",
    ]);
    const second = await runStart([
      "--harness",
      "codex",
      "--cwd",
      repository,
      "--worktree",
      "plain-two",
      "--task",
      "second",
    ]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(await exists(managedPath("plain-one"))).toBe(true);
    expect(await exists(managedPath("plain-two"))).toBe(true);
    expect(store.list()).toEqual([]);
    expect(fake.started).toHaveLength(2);
    expect(fake.started[0]?.allowNestedDelegation).toBeUndefined();
    expect(fake.started[1]?.allowNestedDelegation).toBeUndefined();

    const applied = await post("/v1/thread/apply", {
      threadId: String(first.result?.threadId),
    });
    expect(applied.status).toBe(400);
    expect(errorOf(applied.body).code).toBe("THREAD_NOT_FOUND");
    expect(errorOf(applied.body).message).toContain(
      "a plain --worktree delegation is not governed",
    );
  });

  it("leaves --include-uncommitted true with --worktree ungoverned", async () => {
    await writeFile(path.join(repository, "src", "a.txt"), "uncommitted\n");
    const started = await runStart([
      "--harness",
      "codex",
      "--cwd",
      repository,
      "--worktree",
      "snapshot",
      "--include-uncommitted",
      "true",
      "--task",
      "snapshot",
    ]);
    expect({ code: started.code, error: started.error }).toEqual({ code: 0, error: undefined });
    expect(store.list()).toEqual([]);
    expect(fake.started[0]?.allowNestedDelegation).toBeUndefined();
    expect(await readFile(path.join(managedPath("snapshot"), "src", "a.txt"), "utf8")).toBe(
      "uncommitted\n",
    );
  });

  it("keeps plain HTTP and external-client worktree starts ungoverned", async () => {
    const http = await post("/v1/delegate/start", {
      harnessId: "codex",
      task: "http plain",
      cwd: repository,
      worktree: "ordinary-http",
    });
    expect(http.status).toBe(200);
    expect(http.body.worktree).toMatchObject({ path: managedPath("ordinary-http") });
    expect(fake.started.at(-1)).not.toHaveProperty("worktreeMetadata");
    expect(fake.started.at(-1)).not.toHaveProperty("sourceRepoRoot");
    expect(store.list()).toEqual([]);

    const routed = (await externalStartRoute()({
      harness: "codex",
      task: "router plain",
      cwd: repository,
      worktree: "ordinary-router",
    })) as { worktree: { path: string } };
    expect(routed.worktree.path).toBe(managedPath("ordinary-router"));
    expect(fake.started.at(-1)).not.toHaveProperty("worktreeMetadata");
    expect(fake.started.at(-1)).not.toHaveProperty("sourceRepoRoot");
    expect(store.list()).toEqual([]);
  });

  it("strips forged worktree fields for governed and ungoverned starts", async () => {
    const forged = {
      sourceRepoRoot: path.join(temporary, "evil"),
      worktreeMetadata: {
        path: path.join(temporary, "evil"),
        branch: "evil",
        base: await git("rev-parse", "HEAD"),
      },
    };
    const governed = await post("/v1/delegate/start", {
      tier: "deep",
      scope: ["src"],
      task: "governed forged",
      parentThreadId: "planner-claude",
      cwd: repository,
      worktree: "forged-strip",
      ...forged,
    });
    expect(governed.status).toBe(200);
    expect(fake.started.at(-1)?.worktreeMetadata?.path).toBe(managedPath("forged-strip"));
    expect(path.resolve(fake.started.at(-1)?.sourceRepoRoot ?? "")).toBe(path.resolve(repository));
    expect(fake.started.at(-1)?.worktreeMetadata?.path).not.toBe(forged.worktreeMetadata.path);

    const ungoverned = await post("/v1/delegate/start", {
      harnessId: "codex",
      task: "plain forged",
      cwd: repository,
      worktree: "forged-plain",
      ...forged,
    });
    expect(ungoverned.status).toBe(200);
    expect(fake.started.at(-1)).not.toHaveProperty("worktreeMetadata");
    expect(fake.started.at(-1)).not.toHaveProperty("sourceRepoRoot");

    const routed = (await externalStartRoute()({
      tier: "deep",
      scope: ["docs"],
      task: "router forged",
      cwd: repository,
      worktree: "forged-router",
      ...forged,
    })) as { worktree: { path: string } };
    expect(routed.worktree.path).toBe(managedPath("forged-router"));
    expect(fake.started.at(-1)?.worktreeMetadata?.path).toBe(managedPath("forged-router"));
    expect(fake.started.at(-1)?.worktreeMetadata?.path).not.toBe(forged.worktreeMetadata.path);
  });

  it("ignores forged metadata aimed at an existing plain worktree and keeps it", async () => {
    const plain = await post("/v1/delegate/start", {
      harnessId: "codex",
      task: "plain target",
      cwd: repository,
      worktree: "plain-target",
    });
    expect(plain.status).toBe(200);
    const target = (plain.body.worktree as { path: string }).path;

    const forged = await post("/v1/delegate/start", {
      tier: "deep",
      scope: ["docs"],
      task: "forged target",
      parentThreadId: "planner-claude",
      cwd: target,
      sourceRepoRoot: repository,
      worktreeMetadata: {
        path: target,
        branch: "plain-target",
        base: await git("rev-parse", "HEAD"),
      },
    });
    expect(forged.status).toBe(200);
    expect(fake.started.at(-1)).not.toHaveProperty("worktreeMetadata");
    expect(await exists(target)).toBe(true);
    expect(await git("branch", "--list", "plain-target")).toContain("plain-target");
  });

  it("rejects a retried requestId without treating it as its own conflict", async () => {
    const first = await post("/v1/delegate/start", {
      tier: "deep",
      scope: ["src"],
      task: "retry",
      parentThreadId: "planner-claude",
      cwd: repository,
      requestId: "retry-1",
    });
    const second = await post("/v1/delegate/start", {
      tier: "deep",
      scope: ["src"],
      task: "retry",
      parentThreadId: "planner-claude",
      cwd: repository,
      requestId: "retry-1",
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fake.started).toHaveLength(2);
    expect(store.get(String(second.body.threadId))?.requestId).toBe("retry-1");
  });

  it("rejects malformed governance options at the Registry entry", async () => {
    const invalid = await post("/v1/delegate/start", {
      harnessId: "codex",
      task: "bad nested",
      cwd: repository,
      allowNestedDelegation: "false",
    });
    expect(invalid.status).toBe(400);
    expect(errorOf(invalid.body).code).toBe("INVALID_ARGUMENT");
    expect(errorOf(invalid.body).message).toContain("allowNestedDelegation");

    const blankTier = await post("/v1/delegate/start", {
      harnessId: "codex",
      task: "blank tier",
      cwd: repository,
      tier: "",
    });
    expect(blankTier.status).toBe(400);
    expect(errorOf(blankTier.body).code).toBe("INVALID_ARGUMENT");

    const blankProfile = await post("/v1/delegate/start", {
      harnessId: "codex",
      task: "blank profile",
      cwd: repository,
      profile: "   ",
    });
    expect(blankProfile.status).toBe(400);
    expect(errorOf(blankProfile.body).code).toBe("INVALID_ARGUMENT");

    await expect(
      registry.preflightStart({
        harnessId: "codex",
        task: "bad preflight",
        allowNestedDelegation: "false",
      } as unknown as DelegationStartInput),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fake.started).toHaveLength(0);
  });

  it("defends the Registry against forged metadata before any Harness starts", async () => {
    const started = await post("/v1/delegate/start", {
      tier: "deep",
      scope: ["src"],
      task: "defense",
      parentThreadId: "planner-claude",
      cwd: repository,
      worktree: "defense",
    });
    expect(started.status).toBe(200);
    const childId = String(started.body.threadId);
    const owned = started.body.worktree as { path: string; branch: string; base: string };
    store.update(childId, (draft) => {
      draft.integration = "applied";
    });

    await writeFile(path.join(repository, "src", "b.txt"), "b\n");
    await git("add", ".");
    await git("commit", "-m", "advance");
    const newer = await git("rev-parse", "HEAD");
    await expect(
      registry.start({
        harnessId: "codex",
        task: "newer base",
        parentThreadId: "planner-claude",
        cwd: owned.path,
        sourceRepoRoot: repository,
        scope: ["docs"],
        worktreeMetadata: { ...owned, base: newer },
      } as unknown as DelegationStartInput),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    for (const metadata of [
      { ...owned, untrackedCount: -1 },
      { ...owned, untracked: "not-an-array" },
    ]) {
      await expect(
        registry.start({
          harnessId: "codex",
          task: "bad metadata",
          parentThreadId: "planner-claude",
          cwd: owned.path,
          sourceRepoRoot: repository,
          scope: ["docs"],
          worktreeMetadata: metadata,
        } as unknown as DelegationStartInput),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    expect(fake.started).toHaveLength(1);
  });

  it("does not delete unsafe or foreign worktree checkouts", async () => {
    const parent = path.join(temporary, "repo.worktrees");
    await mkdir(parent, { recursive: true });
    for (const branch of ["", ".", ".."]) {
      await expect(
        removeWorktreeCheckout(repository, path.join(parent, "x"), branch),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(await exists(path.join(repository, "src", "a.txt"))).toBe(true);
    }

    const ordinary = path.join(parent, "ordinary");
    await mkdir(ordinary);
    await writeFile(path.join(ordinary, "keep.txt"), "keep\n");
    expect(await removeWorktreeCheckout(repository, ordinary, "ordinary")).toEqual({
      worktreeRemoved: false,
      branchRemoved: false,
    });
    expect(await readFile(path.join(ordinary, "keep.txt"), "utf8")).toBe("keep\n");

    const locked = await createLinkedWorktree("locked-branch");
    await git("worktree", "lock", locked);
    expect(await removeWorktreeCheckout(repository, locked, "locked-branch")).toEqual({
      worktreeRemoved: false,
      branchRemoved: false,
    });
    expect(await exists(path.join(locked, ".git"))).toBe(true);

    const foreign = await createLinkedWorktree("other-branch", path.join(parent, "wanted"));
    expect(await removeWorktreeCheckout(repository, foreign, "wanted")).toEqual({
      worktreeRemoved: false,
      branchRemoved: false,
    });
    expect(await git("branch", "--list", "other-branch")).toContain("other-branch");
    expect(await exists(path.join(foreign, ".git"))).toBe(true);

    // A non-managed missing path must never trigger branch deletion for an arbitrary branch.
    await git("branch", "keep-unmanaged-branch");
    expect(
      await removeWorktreeCheckout(
        repository,
        path.join(temporary, "not-managed", "keep-unmanaged-branch"),
        "keep-unmanaged-branch",
      ),
    ).toEqual({
      worktreeRemoved: false,
      branchRemoved: false,
    });
    expect(await git("branch", "--list", "keep-unmanaged-branch")).toContain(
      "keep-unmanaged-branch",
    );
  });

  it("applies from a planner checkout that lives inside the managed .worktrees directory", async () => {
    const plannerWorktree = await createLinkedWorktree("planner-managed");
    const response = await post("/v1/delegate/start", {
      tier: "deep",
      scope: ["src"],
      task: "from managed planner",
      parentThreadId: "planner-claude",
      cwd: plannerWorktree,
      worktree: "planner-child",
    });
    expect(response.status).toBe(200);
    const childId = String(response.body.threadId);
    const childWorktree = managedPath("planner-child");
    expect(response.body.worktree).toMatchObject({ path: childWorktree });
    expect(path.resolve(store.get(childId)?.sourceRepoRoot ?? "")).toBe(
      path.resolve(plannerWorktree),
    );

    await writeFile(path.join(childWorktree, "src", "a.txt"), "planner managed edit\n");
    fake.statuses.set(childId, "completed");
    expect((await post("/v1/thread/verify", { threadId: childId })).status).toBe(200);
    expect((await post("/v1/thread/apply", { threadId: childId })).status).toBe(200);
    expect(await readFile(path.join(plannerWorktree, "src", "a.txt"), "utf8")).toBe(
      "planner managed edit\n",
    );
    expect(await readFile(path.join(repository, "src", "a.txt"), "utf8")).toBe("v1\n");
  });

  it("reports artifacts left after apply cleanup without failing the applied patch", async () => {
    const started = await post("/v1/delegate/start", {
      tier: "deep",
      scope: ["src/a.txt"],
      task: "apply note",
      parentThreadId: "planner-claude",
      cwd: repository,
      worktree: "apply-note",
    });
    const childId = String(started.body.threadId);
    const target = managedPath("apply-note");
    await writeFile(path.join(target, "src", "a.txt"), "applied despite leftover\n");
    fake.statuses.set(childId, "completed");
    expect((await post("/v1/thread/verify", { threadId: childId })).status).toBe(200);
    await git("worktree", "remove", "--force", target);
    await mkdir(target);
    await writeFile(path.join(target, "keep.txt"), "keep\n");

    const applied = await post("/v1/thread/apply", { threadId: childId });
    expect(applied.status).toBe(200);
    expect(applied.body.worktreeRemoved).toBe(false);
    expect(String(applied.body.note)).toContain(target);
    expect(await readFile(path.join(repository, "src", "a.txt"), "utf8")).toBe(
      "applied despite leftover\n",
    );
    expect(await readFile(path.join(target, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("marks a discard complete and reports artifacts that need manual cleanup", async () => {
    const started = await post("/v1/delegate/start", {
      tier: "deep",
      scope: ["src"],
      task: "discard note",
      parentThreadId: "planner-claude",
      cwd: repository,
      worktree: "discard-note",
    });
    expect(started.status).toBe(200);
    const childId = String(started.body.threadId);
    const target = managedPath("discard-note");
    fake.statuses.set(childId, "completed");
    await git("worktree", "remove", "--force", target);
    await mkdir(target);
    await writeFile(path.join(target, "keep.txt"), "keep\n");

    const discarded = await post("/v1/thread/discard", { threadId: childId });
    expect(discarded.status).toBe(200);
    expect(discarded.body.discarded).toBe(true);
    expect(discarded.body.worktreeRemoved).toBe(false);
    expect(discarded.body.branchRemoved).toBe(false);
    expect(String(discarded.body.note)).toContain(target);
    expect(await readFile(path.join(target, "keep.txt"), "utf8")).toBe("keep\n");
    expect(store.get(childId)?.integration).toBe("discarded");
  });

  it("cleans a managed worktree when the recorded source checkout is gone", async () => {
    const source = path.join(temporary, "source-checkout");
    await git("worktree", "add", "-b", "source-checkout", source);
    const target = await createLinkedWorktree("cleanup");
    await rm(source, { recursive: true, force: true });
    expect(await removeWorktreeCheckout(source, target, "cleanup")).toEqual({
      worktreeRemoved: true,
      branchRemoved: true,
    });
    expect(await exists(target)).toBe(false);
    expect(await git("branch", "--list", "cleanup")).toBe("");
  });

  it("reclaims a worktree when the coordinator reports an unknown Harness", async () => {
    const originalStart = fake.registration.start;
    fake.registration.start = vi.fn(async (input) => {
      if (input.harnessId === "missing-harness")
        throw new DelegationControlError("HARNESS_NOT_FOUND", "Harness is unavailable", {
          notStarted: true,
        });
      return originalStart(input);
    });
    const started = await post("/v1/delegate/start", {
      harnessId: "missing-harness",
      tier: "deep",
      scope: ["src"],
      task: "wrong harness",
      parentThreadId: "planner-claude",
      cwd: repository,
      worktree: "wrong-harness",
    });
    expect(started.status).toBe(400);
    expect(errorOf(started.body).code).toBe("HARNESS_NOT_FOUND");
    expect(await exists(managedPath("wrong-harness"))).toBe(false);
    expect(await git("branch", "--list", "wrong-harness")).toBe("");
  });

  it("rejects auto-verify for an ungoverned target before sending or watching", async () => {
    const plain = await post("/v1/delegate/start", {
      harnessId: "codex",
      task: "plain target",
      cwd: repository,
      worktree: "auto-target",
    });
    expect(plain.status).toBe(200);
    const threadId = String(plain.body.threadId);
    vi.mocked(fake.registration.send).mockClear();

    const sent = await post("/v1/thread/send", {
      threadId,
      message: "follow-up",
      watchTimeoutMs: 1_000,
      autoVerify: true,
    });
    expect(sent.status).toBe(400);
    expect(errorOf(sent.body).message).toBe(
      "--auto-verify requires a governed delegation (--tier, --scope or --check)",
    );
    expect(fake.registration.send).not.toHaveBeenCalled();

    const watched = await post("/v1/thread/watch", {
      threadId,
      notifyThreadId: "planner-claude",
      timeoutMs: 1_000,
      autoVerify: true,
    });
    expect(watched.status).toBe(400);
    expect(errorOf(watched.body).code).toBe("INVALID_ARGUMENT");
    expect(errorOf(watched.body).message).toBe(
      "--auto-verify requires a governed delegation (--tier, --scope or --check)",
    );
  });

  it("rejects plain worktree auto-verify in the CLI and the server", async () => {
    const cli = await runStart([
      "--harness",
      "codex",
      "--cwd",
      repository,
      "--worktree",
      "auto-cli",
      "--watch",
      "true",
      "--auto-verify",
      "true",
      "--task",
      "auto",
    ]);
    expect(cli.code).toBe(1);
    expect(cli.error?.code).toBe("INVALID_ARGUMENT");
    expect(cli.error?.message).toContain("--auto-verify requires a governed delegation");
    expect(await exists(managedPath("auto-cli"))).toBe(false);

    const http = await post("/v1/delegate/start", {
      harnessId: "codex",
      task: "auto",
      cwd: repository,
      worktree: "auto-http",
      autoVerify: true,
    });
    expect(http.status).toBe(400);
    expect(errorOf(http.body).message).toContain("--auto-verify requires a governed delegation");
    expect(await exists(managedPath("auto-http"))).toBe(false);
    expect(await git("branch", "--list", "auto-http")).toBe("");
  });

  it("rejects an executor's plain worktree before creating anything", async () => {
    const started = await runStart(
      [
        "--harness",
        "codex",
        "--cwd",
        repository,
        "--worktree",
        "executor-orphan",
        "--task",
        "nested",
      ],
      { [DELEGATION_ROLE_ENV]: "executor" },
    );
    expect(started.code).toBe(1);
    expect(started.error?.code).toBe("EXECUTOR_ROLE_FORBIDDEN");
    expect(await exists(managedPath("executor-orphan"))).toBe(false);
    expect(await git("branch", "--list", "executor-orphan")).toBe("");
    expect(fake.started).toHaveLength(0);
  });
});
