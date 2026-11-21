import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";

import { ClaudeCodeAdapter } from "../src/index.js";
import {
  CLAUDE_PROMPT_CACHE_KEEPALIVE_PROMPT,
  isColdPromptCache,
} from "../src/claude-prompt-cache.js";
import type {
  ClaudeAdapterDependencies,
  ClaudePromptCacheRefreshUsage,
  ClaudeTurnTransport,
} from "../src/transport.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createFakeTransport(
  sessionId: string,
  refreshPromptCache: () => Promise<ClaudePromptCacheRefreshUsage>,
): ClaudeTurnTransport {
  return {
    sessionId,
    setAutonomousTurnHandler: () => undefined,
    setIdleTurnHandler: () => undefined,
    setThreadEventHandler: () => undefined,
    setIdleLive: () => undefined,
    hasBackgroundTasks: () => false,
    stopBackgroundTask: async () => undefined,
    stopTasks: async () => undefined,
    start: async () => undefined,
    getContextUsage: async () => null,
    refreshPromptCache,
    getPermissionMode: () => "default",
    setModel: async () => undefined,
    setThinkingOption: async () => undefined,
    setPermissionMode: async () => undefined,
    compact: async () => ({ status: "succeeded" }),
    init: async () => ({ status: "succeeded" }),
    recap: async () => ({ status: "succeeded" }),
    runTurn: async () => ({ status: "succeeded" }),
    steer: async () => undefined,
    respondToInteraction: async () => undefined,
    abort: async () => undefined,
    abortContinuation: async () => undefined,
    close: async () => undefined,
  };
}

describe("Claude Code prompt-cache keep-alive", () => {
  it("classifies cold vs warm prompt cache reads accurately", () => {
    expect(isColdPromptCache({ cacheReadInputTokens: 50_000, cacheCreationInputTokens: 200 })).toBe(
      false,
    );
    expect(isColdPromptCache({ cacheReadInputTokens: 0, cacheCreationInputTokens: 50_000 })).toBe(
      true,
    );
    expect(CLAUDE_PROMPT_CACHE_KEEPALIVE_PROMPT).toContain("OK");
  });

  it("refreshes the prompt cache via transport, detects cold cache, and updates countdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T10:00:00.000Z"));
    const sessionId = "claude-keepalive-session";
    const refreshMock = vi
      .fn<() => Promise<ClaudePromptCacheRefreshUsage>>()
      .mockResolvedValueOnce({
        cacheReadInputTokens: 64_000,
        cacheCreationInputTokens: 128,
        inputTokens: 16,
        outputTokens: 2,
      })
      .mockResolvedValueOnce({
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 64_000,
      });

    const dependencies: ClaudeAdapterDependencies = {
      bypassPermissionsAvailable: () => false,
      createInspector: () => ({
        inspect: async () => ({
          models: [],
          canSelectModel: true,
          canSelectPermissionMode: true,
        }),
        inspectAccount: async () => ({
          plan: "pro",
          credits: {
            usedPercent: 10,
            periodType: "five_hour" as const,
          },
        }),
        close: async () => undefined,
      }),
      createTransport: (input) => createFakeTransport(input.sessionId, refreshMock),
      deleteSession: async () => undefined,
      forkSession: async () => ({ sessionId: "unused" }),
      getSessionInfo: async () => ({ cwd: "/repo" }),
      inspectInstallation: () => undefined,
      readSessionMessages: async () => [
        {
          type: "user",
          uuid: "u-1",
          timestamp: "2026-11-20T09:05:00.000Z",
          message: { role: "user", content: "plan" },
        },
        {
          type: "assistant",
          uuid: "a-1",
          timestamp: "2026-11-20T09:05:10.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        },
      ],
      readSubagentMessages: async () => [],
      randomUUID: () => sessionId,
    };

    const adapter = new ClaudeCodeAdapter({}, dependencies);
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/repo",
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "claude-code",
        nativeSessionId: sessionId,
        formatVersion: 1,
      }),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;

    const events: HarnessOutput[] = [];
    const drain = (async () => {
      for await (const output of session.outputs) events.push(output);
    })();

    const warm = await session.refreshPromptCache?.();
    expect(warm).toEqual({
      ok: true,
      value: {
        refreshedAtUnix: Math.floor(Date.parse("2026-11-20T10:00:00.000Z") / 1000),
        cacheReadInputTokens: 64_000,
        cacheCreationInputTokens: 128,
        inputTokens: 16,
        outputTokens: 2,
        coldCache: false,
      },
    });

    vi.advanceTimersByTime(55 * 60_000);
    const cold = await session.refreshPromptCache?.();
    expect(cold).toMatchObject({
      ok: true,
      value: {
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 64_000,
        coldCache: true,
      },
    });

    await session.close();
    await drain;

    // Closed session rejects further refresh attempts.
    const afterClose = await session.refreshPromptCache?.();
    expect(afterClose?.ok).toBe(false);
    await adapter.close();
  });
});
