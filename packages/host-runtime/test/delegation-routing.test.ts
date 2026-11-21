import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import {
  DELEGATION_PROFILE_ENV,
  buildDelegationRoutingConfig,
  formatDelegationRouteSpec,
  loadDelegationRoutingConfig,
  parseDelegationRouteSpec,
  projectDelegationRoutingPath,
  userDelegationRoutingPath,
  writeDelegationRoutingSetting,
} from "../src/delegation-routing.js";
import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
} from "../src/delegation-types.js";

let temporary: string;

beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "delegation-routing-"));
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

describe("tiered planner-neutral delegation routing", () => {
  it("selects built-in planner profiles automatically", () => {
    const claudePlan = buildDelegationRoutingConfig({ plannerHarnessId: "claude-code" });
    expect(claudePlan.profile).toBe("thread16");
    expect(claudePlan.routes.deep.harnessId).toBe("codex");
    expect(claudePlan.routes.light.harnessId).toBe("deepseek-harness");
    expect(claudePlan.routes.review.harnessId).toBe("claude-code");

    const codexPlan = buildDelegationRoutingConfig({ plannerHarnessId: "codex" });
    expect(codexPlan.profile).toBe("codex-planner");
    expect(codexPlan.routes.deep.harnessId).toBe("claude-code");
    expect(codexPlan.routes.light.harnessId).toBe("deepseek-harness");
    expect(codexPlan.routes.review.harnessId).toBe("codex");
  });

  it("parses and formats harnessId[:model][@thinking] route specs", () => {
    expect(parseDelegationRouteSpec("deepseek-harness")).toEqual({
      harnessId: "deepseek-harness",
    });
    expect(parseDelegationRouteSpec("claude-code:opus@high")).toEqual({
      harnessId: "claude-code",
      model: "opus",
      thinkingOptionId: "high",
    });
    expect(
      formatDelegationRouteSpec({
        harnessId: "codex",
        model: "gpt-5.3-codex",
        thinkingOptionId: "xhigh",
      }),
    ).toBe("codex:gpt-5.3-codex@xhigh");
    expect(() => parseDelegationRouteSpec("Bad Harness Name!")).toThrow(/must be formatted/u);
  });

  it("layers user config under project config and validates writes atomically", async () => {
    const dataDir = path.join(temporary, "data");
    const repoRoot = path.join(temporary, "repo");
    const env = { ...process.env, CODEXHOST_DATA_DIR: dataDir };
    const userFile = userDelegationRoutingPath(env);
    const projectFile = projectDelegationRoutingPath(repoRoot);

    writeDelegationRoutingSetting({
      file: userFile,
      key: "profiles.thread16.deep",
      value: "codex:gpt-5.3-codex@high",
    });
    writeDelegationRoutingSetting({
      file: projectFile,
      key: "profiles.thread16.review",
      value: "antigravity:gemini-4-argon-high",
    });

    const loaded = loadDelegationRoutingConfig({
      repoRoot,
      environment: env,
      plannerHarnessId: "claude-code",
    });
    expect(loaded.routes.deep).toEqual({
      harnessId: "codex",
      model: "gpt-5.3-codex",
      thinkingOptionId: "high",
    });
    expect(loaded.routes.review).toEqual({
      harnessId: "antigravity",
      model: "gemini-4-argon-high",
    });
    expect(loaded.sources).toEqual([userFile, projectFile]);

    // Env profile overrides planner default; explicit profile overrides env.
    const envOverride = loadDelegationRoutingConfig({
      repoRoot,
      environment: { ...env, [DELEGATION_PROFILE_ENV]: "codex-planner" },
      plannerHarnessId: "claude-code",
    });
    expect(envOverride.profile).toBe("codex-planner");

    const explicit = loadDelegationRoutingConfig({
      repoRoot,
      environment: { ...env, [DELEGATION_PROFILE_ENV]: "codex-planner" },
      plannerHarnessId: "claude-code",
      explicitProfile: "thread16",
    });
    expect(explicit.profile).toBe("thread16");

    // Invalid key or value leaves the file untouched.
    const before = await readFile(projectFile, "utf8");
    expect(() =>
      writeDelegationRoutingSetting({
        file: projectFile,
        key: "unknown.key",
        value: "x",
      }),
    ).toThrow(/cannot be set here/u);
    expect(() =>
      writeDelegationRoutingSetting({
        file: projectFile,
        key: "checks.timeoutMinutes",
        value: "-5",
      }),
    ).toThrow(/minutes/u);
    expect(await readFile(projectFile, "utf8")).toBe(before);

    // Unsetting restores built-in route.
    writeDelegationRoutingSetting({
      file: projectFile,
      key: "profiles.thread16.review",
      unset: true,
    });
    const afterUnset = loadDelegationRoutingConfig({
      repoRoot,
      environment: env,
      plannerHarnessId: "claude-code",
    });
    expect(afterUnset.routes.review.harnessId).toBe("claude-code");
  });

  it("routes CLI governance commands (routing, verify, apply, discard, keepalive, tiered start)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: pathname, body });
      return new Response(JSON.stringify({ ok: true, route: pathname }), { status: 200 });
    });
    const env = {
      [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
      [DELEGATION_RUNTIME_TOKEN_ENV]: "token",
    };
    const run = async (args: string[]) => {
      const output = new PassThrough();
      const diagnosticOutput = new PassThrough();
      const code = await runDelegationCli({
        arguments: args,
        environment: env,
        output,
        diagnosticOutput,
        fetchImpl,
      });
      return {
        code,
        stdout: output.read()?.toString(),
        stderr: diagnosticOutput.read()?.toString(),
      };
    };

    expect((await run(["delegate", "routing", "show", "--planner", "codex"])).code).toBe(0);
    expect(
      (
        await run([
          "delegate",
          "routing",
          "set",
          "profiles.thread16.deep",
          "codex",
          "--user",
          "true",
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await run([
          "delegate",
          "start",
          "--tier",
          "light",
          "--scope",
          "src/a.ts",
          "--check",
          "npm test",
          "--task",
          "edit a",
        ])
      ).code,
    ).toBe(0);
    expect((await run(["thread", "verify", "t1"])).code).toBe(0);
    expect(
      (await run(["thread", "apply", "t1", "--allow-out-of-scope", "true", "--force", "true"]))
        .code,
    ).toBe(0);
    expect((await run(["thread", "discard", "t1"])).code).toBe(0);
    expect((await run(["thread", "keepalive", "off", "--thread", "t1"])).code).toBe(0);

    expect(calls.map((c) => c.url)).toEqual([
      "/v1/delegate/routing/show",
      "/v1/delegate/routing/set",
      "/v1/delegate/start",
      "/v1/thread/verify",
      "/v1/thread/apply",
      "/v1/thread/discard",
      "/v1/thread/keepalive",
    ]);
    expect(calls[2]?.body).toMatchObject({
      tier: "light",
      scope: ["src/a.ts"],
      checks: ["npm test"],
      task: "edit a",
    });
    expect(calls[4]?.body).toEqual({
      threadId: "t1",
      allowOutOfScope: true,
      force: true,
    });
    expect(calls[6]?.body).toEqual({
      action: "off",
      threadId: "t1",
    });
  });
});
