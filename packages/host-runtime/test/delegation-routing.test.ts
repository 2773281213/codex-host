import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import {
  DELEGATION_PROFILE_ENV,
  applyDelegationRoutingPatch,
  buildDelegationRoutingConfig,
  formatDelegationRouteSpec,
  loadDelegationRoutingConfig,
  parseDelegationRouteSpec,
  projectDelegationRoutingPath,
  readDelegationRoutingSnapshot,
  renameSyncWithRetry,
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

  it("edits a single tier route without pinning top-level profile and restores automatic planner selection from a pinned file", async () => {
    const dataDir = path.join(temporary, "data");
    const env = { ...process.env, CODEXHOST_DATA_DIR: dataDir };
    const userFile = userDelegationRoutingPath(env);

    // Edit only codex-planner.deep via settings patch without passing defaultProfile.
    const edited = applyDelegationRoutingPatch(
      {
        user: true,
        editProfile: "codex-planner",
        routes: { deep: "claude-code:opus@high" },
      },
      env,
    );
    expect(edited.profile).toBe("codex-planner");
    expect(edited.configuredDefaultProfile).toBeNull();
    expect(edited.routeSpecs).toEqual({
      deep: "claude-code:opus@high",
      light: "deepseek-harness",
      review: "codex",
    });

    // Disk file contains ONLY the modified tier and NO top-level `profile`.
    const savedJson = JSON.parse(await readFile(userFile, "utf8")) as Record<string, unknown>;
    expect(savedJson).toEqual({
      profiles: {
        "codex-planner": {
          deep: { harnessId: "claude-code", model: "opus", thinkingOptionId: "high" },
        },
      },
    });

    // Planner-based automatic selection still picks thread16 for claude-code and codex-planner for codex.
    expect(
      loadDelegationRoutingConfig({ environment: env, plannerHarnessId: "claude-code" }).profile,
    ).toBe("thread16");
    const codexLoaded = loadDelegationRoutingConfig({
      environment: env,
      plannerHarnessId: "codex",
    });
    expect(codexLoaded.profile).toBe("codex-planner");
    expect(codexLoaded.routes.deep).toEqual({
      harnessId: "claude-code",
      model: "opus",
      thinkingOptionId: "high",
    });

    // Simulate a previously broken user config with top-level `profile: "thread16"`.
    await writeFile(
      userFile,
      `${JSON.stringify({ ...savedJson, profile: "thread16" }, null, 2)}\n`,
    );
    expect(readDelegationRoutingSnapshot({}, env).configuredDefaultProfile).toBe("thread16");
    expect(
      loadDelegationRoutingConfig({ environment: env, plannerHarnessId: "codex" }).profile,
    ).toBe("thread16");

    // Switching back to automatic (defaultProfile: null) deletes top-level `profile`.
    const restored = applyDelegationRoutingPatch({ user: true, defaultProfile: null }, env);
    expect(restored.configuredDefaultProfile).toBeNull();
    const afterRestore = JSON.parse(await readFile(userFile, "utf8")) as Record<string, unknown>;
    expect(afterRestore).not.toHaveProperty("profile");
    expect(
      loadDelegationRoutingConfig({ environment: env, plannerHarnessId: "codex" }).profile,
    ).toBe("codex-planner");
  });

  it("rejects checks.shell in project config or ambiguous scope, allows user scope and unset recovery", async () => {
    const dataDir = path.join(temporary, "data");
    const repoRoot = path.join(temporary, "repo");
    const env = { ...process.env, CODEXHOST_DATA_DIR: dataDir };
    const userFile = userDelegationRoutingPath(env);
    const projectFile = projectDelegationRoutingPath(repoRoot);

    // Fail closed: writing checks.shell with neither scope nor environment (and empty layersBelow)
    // is rejected without touching disk, even when the user routing file does not exist yet.
    expect(() =>
      writeDelegationRoutingSetting({
        file: projectFile,
        key: "checks.shell",
        value: "/tmp/evil.sh",
        layersBelow: [],
      }),
    ).toThrow(/user routing config/u);
    expect(fs.existsSync(projectFile)).toBe(false);

    // User config may set and load checks.shell when identified by environment or scope.
    writeDelegationRoutingSetting({
      file: userFile,
      key: "checks.shell",
      value: "/bin/bash",
      environment: env,
    });
    expect(loadDelegationRoutingConfig({ repoRoot, environment: env }).checks.shell).toBe(
      "/bin/bash",
    );

    // A ~/.codexhost/delegation-routing.json-style user path is allowed when scope or environment
    // identifies it as the user file (not misclassified by its `.codexhost` directory name).
    const dotCodexhostDir = path.join(temporary, ".codexhost");
    const dotCodexhostUserFile = path.join(dotCodexhostDir, "delegation-routing.json");
    writeDelegationRoutingSetting({
      file: dotCodexhostUserFile,
      key: "checks.shell",
      value: "/bin/sh",
      environment: { CODEXHOST_DATA_DIR: dotCodexhostDir },
    });
    expect(JSON.parse(await readFile(dotCodexhostUserFile, "utf8"))).toEqual({
      checks: { shell: "/bin/sh" },
    });

    // Project config rejects checks.shell on set (both via explicit scope and via caller environment).
    expect(() =>
      writeDelegationRoutingSetting({
        file: projectFile,
        key: "checks.shell",
        value: "/tmp/evil.sh",
        scope: "project",
      }),
    ).toThrow(/user routing config/u);
    expect(() =>
      writeDelegationRoutingSetting({
        file: projectFile,
        key: "checks.shell",
        value: "/tmp/evil.sh",
        environment: env,
      }),
    ).toThrow(/user routing config/u);

    // A legacy project file containing checks.shell fails load with remediation instructions,
    // can be cleaned up with unset, and loads cleanly afterward.
    await mkdir(path.dirname(projectFile), { recursive: true });
    await writeFile(
      projectFile,
      JSON.stringify({ checks: { shell: "/tmp/evil.sh", timeoutMinutes: 15 } }),
    );
    expect(() => loadDelegationRoutingConfig({ repoRoot, environment: env })).toThrow(
      /unset checks\.shell/u,
    );

    const cleaned = writeDelegationRoutingSetting({
      file: projectFile,
      key: "checks.shell",
      unset: true,
      scope: "project",
    });
    expect(cleaned.removed).toBe(true);
    const recovered = loadDelegationRoutingConfig({ repoRoot, environment: env });
    expect(recovered.checks).toEqual({ timeoutMinutes: 15, shell: "/bin/bash" });
  });

  it("validates user patches against user layer only, rejects unknown editProfile before disk write, and deduplicates same-file user/project paths", async () => {
    const dataDir = path.join(temporary, "data");
    const repoRoot = path.join(temporary, "repo");
    const env = {
      ...process.env,
      CODEXHOST_DATA_DIR: dataDir,
      [DELEGATION_PROFILE_ENV]: "thread16",
    };
    const userFile = userDelegationRoutingPath(env);
    const projectFile = projectDelegationRoutingPath(repoRoot);

    // Unknown defaultProfile is rejected even when CODEXHOST_DELEGATION_PROFILE is set.
    expect(() =>
      applyDelegationRoutingPatch({ user: true, defaultProfile: "nonexistent-profile" }, env),
    ).toThrow(/not defined/u);

    // Unknown editProfile is rejected BEFORE writing anything to disk.
    expect(() =>
      applyDelegationRoutingPatch(
        { user: true, editProfile: "ghost", defaultProfile: "thread16" },
        env,
      ),
    ).toThrow(/not defined/u);
    expect(fs.existsSync(userFile)).toBe(false);

    // A profile defined only in the project layer must NOT be accepted as user defaultProfile.
    await mkdir(path.dirname(projectFile), { recursive: true });
    await writeFile(
      projectFile,
      JSON.stringify({
        profiles: {
          "project-only": {
            deep: { harnessId: "codex" },
            light: { harnessId: "deepseek-harness" },
            review: { harnessId: "claude-code" },
          },
        },
      }),
    );
    expect(() =>
      applyDelegationRoutingPatch(
        { user: true, repoRoot, defaultProfile: "project-only" },
        { ...process.env, CODEXHOST_DATA_DIR: dataDir },
      ),
    ).toThrow(/not defined/u);
    expect(fs.existsSync(userFile)).toBe(false);

    // When CODEXHOST_DATA_DIR points at repoRoot/.codexhost (even with different casing on Windows),
    // the file loads once as user scope with checks.shell intact and accepts user:false patches.
    const sameRepoRoot = path.join(temporary, "same-repo");
    const sameProjectFile = projectDelegationRoutingPath(sameRepoRoot);
    await mkdir(path.dirname(sameProjectFile), { recursive: true });
    await writeFile(sameProjectFile, JSON.stringify({ checks: { shell: "/bin/bash" } }));
    const sameDataDir =
      process.platform === "win32"
        ? path.join(sameRepoRoot, ".CODEXHOST")
        : path.join(sameRepoRoot, ".", ".codexhost");
    const sameEnv = { ...process.env, CODEXHOST_DATA_DIR: sameDataDir };
    const loaded = loadDelegationRoutingConfig({ repoRoot: sameRepoRoot, environment: sameEnv });
    expect(loaded.checks.shell).toBe("/bin/bash");
    expect(loaded.sources).toHaveLength(1);
    const patched = applyDelegationRoutingPatch(
      {
        user: false,
        repoRoot: sameRepoRoot,
        editProfile: "thread16",
        routes: { deep: "codex" },
      },
      sameEnv,
    );
    expect(patched.routeSpecs.deep).toBe("codex");
  });

  it("blocks prototype pollution, prototype lookups, unknown-scope checks.shell, and env profile bleed during user patch", async () => {
    const dataDir = path.join(temporary, "proto-data");
    const repoRoot = path.join(temporary, "proto-repo");
    const env = { ...process.env, CODEXHOST_DATA_DIR: dataDir };
    const userFile = userDelegationRoutingPath(env);
    const projectFile = projectDelegationRoutingPath(repoRoot);

    // Reserved prototype keys cannot pollute Object.prototype or load as profiles.
    expect(() =>
      writeDelegationRoutingSetting({
        file: userFile,
        key: "profiles.__proto__.deep",
        value: "codex",
        scope: "user",
      }),
    ).toThrow(/reserved/u);
    expect(Object.prototype).not.toHaveProperty("deep");

    // Prototype method names are never mistaken for defined profiles or planner mappings.
    expect(() => readDelegationRoutingSnapshot({ profile: "toString" }, env)).toThrow(
      /not defined/u,
    );
    expect(
      loadDelegationRoutingConfig({ environment: env, plannerHarnessId: "toString" }).profile,
    ).toBe("thread16");

    // buildDelegationRoutingConfig fails closed when checks.shell appears on a layer without scope.
    expect(() =>
      buildDelegationRoutingConfig({
        layers: [{ file: projectFile, data: { checks: { shell: "/tmp/evil.sh" } } }],
      }),
    ).toThrow(/user routing config/u);

    // User-layer patch validation is not broken when CODEXHOST_DELEGATION_PROFILE names a project-only profile.
    await mkdir(path.dirname(projectFile), { recursive: true });
    await writeFile(
      projectFile,
      JSON.stringify({
        profiles: {
          "team-proj": {
            deep: { harnessId: "codex" },
            light: { harnessId: "deepseek-harness" },
            review: { harnessId: "claude-code" },
          },
        },
      }),
    );
    const patched = applyDelegationRoutingPatch(
      { user: true, repoRoot, defaultProfile: "thread16" },
      { ...env, [DELEGATION_PROFILE_ENV]: "team-proj" },
    );
    expect(patched.configuredDefaultProfile).toBe("thread16");
  });

  it("waits with Atomics.wait instead of busy-spinning when renameSyncWithRetry retries", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    let attempts = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("busy") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
    });
    const waitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    try {
      renameSyncWithRetry("a.tmp", "a.json");
      expect(renameSpy).toHaveBeenCalledTimes(3);
      expect(waitSpy).toHaveBeenCalledTimes(2);
      expect(waitSpy).toHaveBeenCalledWith(expect.any(Int32Array), 0, 0, 25);
    } finally {
      waitSpy.mockRestore();
      renameSpy.mockRestore();
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
  });
});
