import { describe, expect, it } from "vitest";

import {
  DELEGATION_EXECUTOR_ROLE,
  buildGovernedTaskPrompt,
  checkExecutorRoleGuard,
  coversScope,
  holdsWriteScope,
  normalizeScopePath,
  outOfScopeFiles,
  requestsGovernance,
  scopesOverlap,
  validateGovernancePolicy,
} from "../src/delegation-policy.js";
import { DelegationControlError } from "../src/delegation-types.js";

describe("delegation policy and guardrails", () => {
  it("normalizes valid scope paths and rejects traversal or invalid paths", () => {
    expect(normalizeScopePath(".")).toBe(".");
    expect(normalizeScopePath("./")).toBe(".");
    expect(normalizeScopePath("./src/foo/")).toBe("src/foo");
    expect(normalizeScopePath("packages/host-runtime/src/a.ts")).toBe(
      "packages/host-runtime/src/a.ts",
    );

    for (const bad of [
      "",
      "/",
      "/etc/passwd",
      "../escape",
      "src/../escape",
      ".git/config",
      ".GIT",
      ".Git/hooks",
      "src/.git/hooks",
      "src//double",
      "src\\windows",
      "C:drive",
      "bad\nline",
    ]) {
      expect(() => normalizeScopePath(bad)).toThrow(DelegationControlError);
    }
  });

  it("checks directory-prefix scope coverage and overlap accurately", () => {
    expect(coversScope(".", "any/file.ts")).toBe(true);
    expect(coversScope("src", "src/a.ts")).toBe(true);
    expect(coversScope("src/a", "src/ab/file.ts")).toBe(false);
    expect(scopesOverlap(["src/a"], ["src/b"])).toBeNull();
    expect(scopesOverlap(["src"], ["src/nested/file.ts"])).toEqual({
      left: "src",
      right: "src/nested/file.ts",
    });
    expect(outOfScopeFiles(["src/a.ts", "docs/readme.md"], ["src"])).toEqual(["docs/readme.md"]);
  });

  it("enforces deep, light, and review tier rules", () => {
    expect(() => validateGovernancePolicy({ tier: "deep" })).toThrow(/must declare its scope/u);
    expect(validateGovernancePolicy({ tier: "deep", scope: ["."] })).toMatchObject({
      tier: "deep",
      write: true,
      scope: ["."],
    });

    expect(() => validateGovernancePolicy({ tier: "light", checks: ["npm test"] })).toThrow(
      /must declare the files/u,
    );
    expect(() =>
      validateGovernancePolicy({ tier: "light", scope: ["."], checks: ["npm test"] }),
    ).toThrow(/may not claim the whole repository/u);
    expect(() => validateGovernancePolicy({ tier: "light", scope: ["src/a.ts"] })).toThrow(
      /at least one check/u,
    );
    expect(() =>
      validateGovernancePolicy({
        tier: "light",
        scope: Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`),
        checks: ["npm test"],
      }),
    ).toThrow(/at most 10 scope entries/u);

    expect(
      validateGovernancePolicy({
        tier: "light",
        scope: ["src/a.ts"],
        checks: ["npm test"],
      }),
    ).toMatchObject({ tier: "light", write: true, scope: ["src/a.ts"], checks: ["npm test"] });

    expect(validateGovernancePolicy({ tier: "review" })).toMatchObject({
      tier: "review",
      write: false,
      scope: ["."],
    });
  });

  it("enforces concurrent write-scope conflict locks until applied or discarded", () => {
    const active = {
      threadId: "t-running",
      write: true,
      status: "running",
      integration: "none" as const,
      sourceRepoRoot: "/repo/app",
      scope: ["packages/a"],
    };
    const unintegrated = {
      threadId: "t-done",
      write: true,
      status: "completed",
      integration: "none" as const,
      sourceRepoRoot: "/repo/app",
      scope: ["packages/b"],
      worktree: { path: "/repo/app.worktrees/b" },
    };
    const applied = {
      threadId: "t-applied",
      write: true,
      status: "completed",
      integration: "applied" as const,
      sourceRepoRoot: "/repo/app",
      scope: ["packages/c"],
    };
    const otherRepo = {
      threadId: "t-other",
      write: true,
      status: "running",
      integration: "none" as const,
      sourceRepoRoot: "/repo/other",
      scope: ["."],
    };

    expect(holdsWriteScope(active)).toBe(true);
    expect(holdsWriteScope(unintegrated)).toBe(true);
    expect(holdsWriteScope(applied)).toBe(false);

    expect(() =>
      validateGovernancePolicy({
        tier: "deep",
        scope: ["packages/a/file.ts"],
        sourceRepoRoot: "/repo/app",
        existingRecords: [active, unintegrated, applied, otherRepo],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "SCOPE_CONFLICT",
      }),
    );

    expect(() =>
      validateGovernancePolicy({
        tier: "deep",
        scope: ["packages/b/file.ts"],
        sourceRepoRoot: "/repo/app",
        existingRecords: [active, unintegrated, applied, otherRepo],
      }),
    ).toThrow(expect.objectContaining({ code: "SCOPE_CONFLICT" }));

    // Applied scope and other repositories do not block.
    expect(
      validateGovernancePolicy({
        tier: "deep",
        scope: ["packages/c/file.ts"],
        sourceRepoRoot: "/repo/app",
        existingRecords: [active, unintegrated, applied, otherRepo],
      }).scope,
    ).toEqual(["packages/c/file.ts"]);

    // Read-only review never conflicts with write scopes.
    expect(
      validateGovernancePolicy({
        tier: "review",
        sourceRepoRoot: "/repo/app",
        existingRecords: [active],
      }).write,
    ).toBe(false);
  });

  it("treats an omitted write scope as the whole repository for conflicts", () => {
    const holder = {
      threadId: "t-running",
      write: true,
      status: "running",
      integration: "none" as const,
      sourceRepoRoot: "/repo/app",
      scope: ["packages/a"],
    };
    expect(validateGovernancePolicy({}).claimsScope).toBe(true);
    expect(() =>
      validateGovernancePolicy({
        sourceRepoRoot: "/repo/app",
        existingRecords: [holder],
      }),
    ).toThrow(expect.objectContaining({ code: "SCOPE_CONFLICT" }));
  });

  it("holds a worktree write scope through terminal states until integration", () => {
    const record = {
      write: true,
      integration: "none" as const,
      claimsScope: true,
      worktree: { path: "/repo/app.worktrees/a" },
    };
    for (const status of ["completed", "failed", "interrupted"]) {
      expect(holdsWriteScope({ ...record, status })).toBe(true);
    }
    expect(holdsWriteScope({ ...record, status: "completed", integration: "applied" })).toBe(false);
    expect(holdsWriteScope({ ...record, status: "completed", integration: "discarded" })).toBe(
      false,
    );

    const direct = { write: true, integration: "none" as const, claimsScope: true };
    expect(holdsWriteScope({ ...direct, status: "running" })).toBe(true);
    expect(holdsWriteScope({ ...direct, status: "completed" })).toBe(false);
  });

  it("does not treat a same-request retry as its own conflict", () => {
    const record = {
      threadId: "t-retry",
      write: true,
      status: "running",
      integration: "none" as const,
      sourceRepoRoot: "/repo/app",
      scope: ["."],
      requestId: "request-1",
      parentThreadId: "planner",
    };
    expect(() =>
      validateGovernancePolicy({
        sourceRepoRoot: "/repo/app",
        existingRecords: [record],
        requestId: "request-1",
        parentThreadId: "planner",
      }),
    ).not.toThrow();
    expect(() =>
      validateGovernancePolicy({
        sourceRepoRoot: "/repo/app",
        existingRecords: [record],
        requestId: "request-1",
      }),
    ).not.toThrow();
    expect(() =>
      validateGovernancePolicy({
        sourceRepoRoot: "/repo/app",
        existingRecords: [record],
        requestId: "request-1",
        parentThreadId: "someone-else",
      }),
    ).toThrow(expect.objectContaining({ code: "SCOPE_CONFLICT" }));
  });

  it("treats malformed governance options as governance intent", () => {
    expect(requestsGovernance({})).toBe(false);
    expect(requestsGovernance({ scope: [] })).toBe(false);
    expect(requestsGovernance({ checks: [] })).toBe(false);
    expect(requestsGovernance({ allowNestedDelegation: true })).toBe(false);
    expect(requestsGovernance({ allowNestedDelegation: false })).toBe(true);
    expect(requestsGovernance({ allowNestedDelegation: "false" })).toBe(true);
    expect(requestsGovernance({ tier: "" })).toBe(true);
    expect(requestsGovernance({ profile: "   " })).toBe(true);
  });

  it.skipIf(process.platform !== "win32")(
    "compares scope coverage case-insensitively on Windows",
    () => {
      expect(coversScope("SRC", "src/A.ts")).toBe(true);
      expect(scopesOverlap(["SRC"], ["src/nested"])).not.toBeNull();
    },
  );

  it("blocks recursive delegation from governed executor roles", () => {
    expect(() => checkExecutorRoleGuard({})).not.toThrow();
    expect(() => checkExecutorRoleGuard({ callerRole: DELEGATION_EXECUTOR_ROLE })).toThrow(
      expect.objectContaining({ code: "EXECUTOR_ROLE_FORBIDDEN" }),
    );
    expect(() => checkExecutorRoleGuard({ callerIsExecutorThread: true })).toThrow(
      expect.objectContaining({ code: "EXECUTOR_ROLE_FORBIDDEN" }),
    );
  });

  it("formats governed task prompt with worktree, scope, checks, and acceptance", () => {
    const prompt = buildGovernedTaskPrompt({
      task: "Fix parser edge case",
      tier: "light",
      write: true,
      scope: ["src/parser.ts"],
      checks: ["npm test -- parser"],
      acceptance: "Handles empty input cleanly",
      baseCommit: "abcdef1234567890",
      isWorktree: true,
    });
    expect(prompt).toContain("Fix parser edge case");
    expect(prompt).toContain("Acceptance criteria:");
    expect(prompt).toContain(
      "isolated git worktree prepared for this delegation from commit abcdef123456",
    );
    expect(prompt).toContain("Change only files covered by this scope: src/parser.ts");
    expect(prompt).toContain("`npm test -- parser`");
    expect(prompt).toContain("CODEXHOST_DELEGATION_ROLE=executor");
  });
});
