import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROMPT_CACHE_RETRY_BACKOFF_MS,
  PROMPT_CACHE_TTL_MS,
  PromptCacheKeepAliveService,
  decidePromptCacheKeepAlive,
  type PromptCacheKeepAliveDecisionInput,
} from "../src/prompt-cache-keepalive.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function baseDecision(
  overrides: Partial<PromptCacheKeepAliveDecisionInput> = {},
): PromptCacheKeepAliveDecisionInput {
  return {
    now: 55 * MINUTE,
    watchedCount: 1,
    busy: false,
    enabled: true,
    lastRequestAt: 0,
    lastRefreshAt: null,
    retryAfter: null,
    paused: null,
    intervalMs: 55 * MINUTE,
    ttlMs: PROMPT_CACHE_TTL_MS,
    ceilingMs: 8 * HOUR,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("prompt-cache keep-alive decision engine and service", () => {
  it("evaluates all 10 keep-alive decision states accurately", () => {
    expect(decidePromptCacheKeepAlive(baseDecision())).toBe("refresh");
    expect(decidePromptCacheKeepAlive(baseDecision({ enabled: false }))).toBe("disabled");
    expect(decidePromptCacheKeepAlive(baseDecision({ paused: "off" }))).toBe("paused");
    expect(decidePromptCacheKeepAlive(baseDecision({ watchedCount: 0 }))).toBe("no-watches");
    expect(decidePromptCacheKeepAlive(baseDecision({ busy: true }))).toBe("busy");
    expect(decidePromptCacheKeepAlive(baseDecision({ lastRequestAt: null }))).toBe("no-request");
    expect(
      decidePromptCacheKeepAlive(
        baseDecision({ now: 8 * HOUR, lastRequestAt: 0, lastRefreshAt: 7 * HOUR + 30 * MINUTE }),
      ),
    ).toBe("ceiling");
    expect(decidePromptCacheKeepAlive(baseDecision({ now: 60 * MINUTE }))).toBe("cold");
    expect(
      decidePromptCacheKeepAlive(baseDecision({ now: 56 * MINUTE, retryAfter: 58 * MINUTE })),
    ).toBe("backoff");
    expect(decidePromptCacheKeepAlive(baseDecision({ now: 54 * MINUTE }))).toBe("not-due");
  });

  it("runs lazy timer only while watches exist, refreshes every 55m, and stops at 8h ceiling", async () => {
    const watches = new Map<string, number>();
    const refreshPromptCache = vi.fn(async () => ({
      ok: true as const,
      value: {
        refreshedAtUnix: Math.floor(Date.now() / 1000),
        cacheReadInputTokens: 42_000,
        cacheCreationInputTokens: 120,
        coldCache: false,
      },
    }));
    const service = new PromptCacheKeepAliveService({
      activeWatchCounts: () => watches,
      resolveTarget: (threadId) =>
        threadId === "planner-1"
          ? {
              threadId,
              harnessId: "claude-code",
              busy: false,
              canRefresh: true,
              refreshPromptCache,
            }
          : undefined,
    });

    // No watches yet -> zero background timers.
    service.recordRequest("planner-1", 0);
    expect(vi.getTimerCount()).toBe(0);

    // Register watch -> timer starts lazily.
    watches.set("planner-1", 1);
    service.syncTimer();
    expect(vi.getTimerCount()).toBe(1);

    // At 54 minutes, not yet due.
    await vi.advanceTimersByTimeAsync(54 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(0);

    // At 55 minutes, first refresh fires.
    await vi.advanceTimersByTimeAsync(1 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(1);
    expect(service.status("planner-1").threads[0]).toMatchObject({
      refreshes: 1,
      lastCacheReadTokens: 42_000,
      lastCacheWriteTokens: 120,
      lastDecision: "refreshed",
      paused: null,
    });

    // Another 55 minutes -> second refresh fires.
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(2);

    // Jump past the 8-hour ceiling -> stops refreshing with decision=ceiling.
    await vi.advanceTimersByTimeAsync(7 * HOUR);
    const totalBeforeExtra = refreshPromptCache.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(refreshPromptCache).toHaveBeenCalledTimes(totalBeforeExtra);
    expect(service.status("planner-1").threads[0]?.lastDecision).toBe("ceiling");

    // Watches clear -> timer stops cleanly.
    watches.clear();
    service.syncTimer();
    expect(vi.getTimerCount()).toBe(0);
    service.stop();
  });

  it("auto-pauses on cold cache (5-minute TTL) and resumes on explicit on", async () => {
    const watches = new Map([["planner-1", 1]]);
    const diagnostics: string[] = [];
    const refreshPromptCache = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          refreshedAtUnix: 3300,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 35_000,
          coldCache: true,
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          refreshedAtUnix: 6600,
          cacheReadInputTokens: 35_000,
          cacheCreationInputTokens: 50,
          coldCache: false,
        },
      });
    const service = new PromptCacheKeepAliveService({
      activeWatchCounts: () => watches,
      resolveTarget: (threadId) => ({
        threadId,
        harnessId: "claude-code",
        busy: false,
        canRefresh: true,
        refreshPromptCache,
      }),
      diagnose: (message) => diagnostics.push(message),
    });

    service.recordRequest("planner-1", 0);
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(1);
    expect(service.status("planner-1").threads[0]).toMatchObject({
      paused: "cold-cache",
      lastDecision: "refreshed-cold",
    });
    expect(diagnostics[0]).toContain("CLAUDE_CODE_PROMPT_CACHE_TTL=1h");

    // Stays paused even after another 55 minutes.
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(1);

    // Explicit resume + new request re-enables keep-alive.
    service.resume("planner-1");
    service.recordRequest("planner-1", Date.now());
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(2);
    expect(service.status("planner-1").threads[0]?.paused).toBeNull();
    service.stop();
  });

  it("backs off for 5 minutes after a transient failure and records compactions", async () => {
    const watches = new Map([["planner-1", 1]]);
    const refreshPromptCache = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "nativeFailure" as const, message: "503", retryable: true },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          refreshedAtUnix: 3540,
          cacheReadInputTokens: 10_000,
          cacheCreationInputTokens: 100,
          coldCache: false,
        },
      });
    const service = new PromptCacheKeepAliveService({
      activeWatchCounts: () => watches,
      resolveTarget: (threadId) => ({
        threadId,
        harnessId: "claude-code",
        busy: false,
        canRefresh: true,
        refreshPromptCache,
      }),
    });

    service.recordRequest("planner-1", 0);
    service.recordCompaction("planner-1", "auto", 10 * MINUTE);
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(1);
    expect(service.status("planner-1").threads[0]).toMatchObject({
      lastDecision: "refresh-nativeFailure",
      retryAfter: 55 * MINUTE + PROMPT_CACHE_RETRY_BACKOFF_MS,
      compactions: [{ at: 10 * MINUTE, trigger: "auto" }],
    });

    // Does not retry before backoff elapses (still < 60m TTL at 59m? Wait: 55+5=60m -> cold).
    // Test with shorter interval (50m) so retry succeeds within the 60m TTL.
    service.configure({ enabled: true, intervalMinutes: 50, ceilingHours: 8 });
    service.recordRequest("planner-1", Date.now());
    refreshPromptCache.mockReset();
    refreshPromptCache
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "nativeFailure" as const, message: "503", retryable: true },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          refreshedAtUnix: Math.floor((Date.now() + 55 * MINUTE) / 1000),
          cacheReadInputTokens: 10_000,
          cacheCreationInputTokens: 100,
          coldCache: false,
        },
      });

    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(2);
    expect(service.status("planner-1").threads[0]?.lastDecision).toBe("refreshed");
    service.stop();
  });
});
