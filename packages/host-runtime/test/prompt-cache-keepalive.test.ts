import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  DEFAULT_PROMPT_CACHE_KEEPALIVE_SETTINGS,
  IDLE_RELEASE_SETTINGS_METHOD,
  LOADED_SESSIONS_METHOD,
  harnessIdSchema,
} from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROMPT_CACHE_RETRY_BACKOFF_MS,
  PROMPT_CACHE_TTL_MS,
  PromptCacheKeepAliveService,
  decidePromptCacheKeepAlive,
  type PromptCacheKeepAliveDecisionInput,
} from "../src/prompt-cache-keepalive.js";
import {
  createFixture,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

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

  it("is disabled by default and starts no background timers until enabled", async () => {
    expect(DEFAULT_PROMPT_CACHE_KEEPALIVE_SETTINGS.enabled).toBe(false);
    const watches = new Map([["planner-1", 1]]);
    const refreshPromptCache = vi.fn(async () => ({
      ok: true as const,
      value: {
        refreshedAtUnix: Math.floor(Date.now() / 1000),
        cacheReadInputTokens: 10_000,
        cacheCreationInputTokens: 10,
        coldCache: false,
      },
    }));
    const service = new PromptCacheKeepAliveService({
      activeWatchCounts: () => watches,
      resolveTarget: (threadId) => ({
        threadId,
        harnessId: "claude-code",
        busy: false,
        canRefresh: true,
        lastResponseAtMs: 0,
        refreshPromptCache,
      }),
    });
    expect(service.settings.enabled).toBe(false);
    service.syncTimer();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(refreshPromptCache).not.toHaveBeenCalled();
    service.stop();
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
    service.configure({ enabled: true, intervalMinutes: 55, ceilingHours: 8 });

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
    service.configure({ enabled: true, intervalMinutes: 55, ceilingHours: 8 });

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
    service.configure({ enabled: true, intervalMinutes: 55, ceilingHours: 8 });

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

  it("seeds lastRequestAt from resumed adapter lastResponseAtMs and pauses non-retryable unsupported errors", async () => {
    const watches = new Map([["resumed-1", 1]]);
    const refreshPromptCache = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          refreshedAtUnix: 55 * 60,
          cacheReadInputTokens: 20_000,
          cacheCreationInputTokens: 20,
          coldCache: false,
        },
      })
      .mockResolvedValueOnce({
        ok: false as const,
        error: {
          code: "unsupported" as const,
          message: "CLAUDE_CODE_PROMPT_CACHE_TTL is set to 5m",
          retryable: false,
        },
      });
    const service = new PromptCacheKeepAliveService({
      activeWatchCounts: () => watches,
      resolveTarget: (threadId) => ({
        threadId,
        harnessId: "claude-code",
        busy: false,
        canRefresh: true,
        lastResponseAtMs: 0,
        refreshPromptCache,
      }),
    });
    service.configure({ enabled: true, intervalMinutes: 55, ceilingHours: 8 });

    // Resumed thread never called recordRequest(), yet status & tick see adapter lastResponseAtMs.
    expect(service.status("resumed-1").threads[0]?.lastRequestAt).toBe(0);
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(1);

    // Non-retryable unsupported error pauses the thread instead of retrying every 5 minutes.
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(2);
    expect(service.status("resumed-1").threads[0]).toMatchObject({
      paused: "unsupported",
      lastDecision: "refresh-unsupported",
      retryAfter: null,
    });
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it("backs off on invalidState instead of pausing permanently and clears error pauses on resume or new request", async () => {
    const watches = new Map([["planner-1", 1]]);
    const refreshPromptCache = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: {
          code: "invalidState" as const,
          message: "Claude Code Session has no persisted native history to refresh",
          retryable: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          refreshedAtUnix: 55 * 60,
          cacheReadInputTokens: 25_000,
          cacheCreationInputTokens: 25,
          coldCache: false,
        },
      })
      .mockResolvedValueOnce({
        ok: false as const,
        error: {
          code: "unsupported" as const,
          message: "CLAUDE_CODE_PROMPT_CACHE_TTL is set to 5m",
          retryable: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          refreshedAtUnix: 160 * 60,
          cacheReadInputTokens: 25_000,
          cacheCreationInputTokens: 25,
          coldCache: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          refreshedAtUnix: 220 * 60,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          inputTokens: 18_000,
          coldCache: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          refreshedAtUnix: 280 * 60,
          cacheReadInputTokens: 25_000,
          cacheCreationInputTokens: 25,
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
    service.configure({ enabled: true, intervalMinutes: 50, ceilingHours: 8 });
    service.recordRequest("planner-1", 0);

    // invalidState backs off for 5m and retries rather than pausing permanently.
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(1);
    expect(service.status("planner-1").threads[0]).toMatchObject({
      paused: null,
      lastDecision: "refresh-invalidState",
      retryAfter: 50 * MINUTE + PROMPT_CACHE_RETRY_BACKOFF_MS,
    });
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(2);
    expect(service.status("planner-1").threads[0]?.lastDecision).toBe("refreshed");

    // Unsupported pauses, and global resume() clears error-class pauses.
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(3);
    expect(service.status("planner-1").threads[0]?.paused).toBe("unsupported");
    service.resume();
    expect(service.status("planner-1").threads[0]?.paused).toBeNull();
    service.recordRequest("planner-1", Date.now());
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(4);

    // Zero cache read + zero cache creation with positive inputTokens pauses as cache-disabled.
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(5);
    expect(service.status("planner-1").threads[0]).toMatchObject({
      paused: "cache-disabled",
      lastDecision: "refreshed-cache-disabled",
    });

    // Real turns preserve persistent pauses (cache-disabled, cold-cache, off) until explicit resume.
    service.recordRequest("planner-1", Date.now());
    expect(service.status("planner-1").threads[0]?.paused).toBe("cache-disabled");
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(5);

    service.resume("planner-1");
    service.recordRequest("planner-1", Date.now());
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(refreshPromptCache).toHaveBeenCalledTimes(6);

    service.pause("planner-1", "cold-cache");
    for (let round = 0; round < 3; round += 1) {
      service.recordRequest("planner-1", Date.now());
      await vi.advanceTimersByTimeAsync(60 * MINUTE);
    }
    expect(service.status("planner-1").threads[0]?.paused).toBe("cold-cache");
    expect(refreshPromptCache).toHaveBeenCalledTimes(6);

    service.pause("planner-1", "off");
    service.recordRequest("planner-1", Date.now());
    expect(service.status("planner-1").threads[0]?.paused).toBe("off");
    service.stop();
  });

  it("attempts post-reload probe only once when the probe fails and preserves user off across idle-release forget", async () => {
    vi.setSystemTime(75 * MINUTE);
    const watches = new Map([["failing-reloaded", 1]]);
    const refreshPromptCache = vi.fn(async () => ({
      ok: false as const,
      error: { code: "nativeFailure" as const, message: "upstream 503", retryable: true },
    }));
    const service = new PromptCacheKeepAliveService({
      activeWatchCounts: () => watches,
      resolveTarget: (threadId) => ({
        threadId,
        harnessId: "claude-code",
        busy: false,
        canRefresh: true,
        lastResponseAtMs: 0,
        refreshPromptCache,
      }),
    });
    service.configure({ enabled: true, intervalMinutes: 55, ceilingHours: 8 });

    // One probe fires immediately past 60m TTL, fails, and never retries across 2+ hours.
    await service.tick();
    expect(refreshPromptCache).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(refreshPromptCache).toHaveBeenCalledTimes(1);
    expect(service.status("failing-reloaded").threads[0]?.lastDecision).toBe("cold");

    // Idle-release forget preserves user "off" while resetting session timing fields.
    service.pause("user-paused", "off");
    service.recordRequest("user-paused", Date.now());
    service.forget("user-paused", { preserveUserPause: true });
    expect(service.status("user-paused").threads[0]).toMatchObject({
      paused: "off",
      lastRequestAt: 0,
      lastRefreshAt: null,
      refreshes: 0,
    });
    // Non-"off" entries are removed by idle-release forget, and delete forget removes "off" too.
    watches.delete("failing-reloaded");
    service.forget("failing-reloaded", { preserveUserPause: true });
    expect(service.status().threads.some((t) => t.threadId === "failing-reloaded")).toBe(false);
    service.forget("user-paused");
    expect(service.status().threads.some((t) => t.threadId === "user-paused")).toBe(false);
    service.stop();
  });

  it("preserves a concurrent user off pause when an in-flight refresh finishes cold or unsupported", async () => {
    vi.setSystemTime(56 * MINUTE);
    const watches = new Map([["inflight", 1]]);
    const deferred = Promise.withResolvers<{
      ok: true;
      value: {
        refreshedAtUnix: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        coldCache: boolean;
      };
    }>();
    const service = new PromptCacheKeepAliveService({
      activeWatchCounts: () => watches,
      resolveTarget: () => ({
        threadId: "inflight",
        harnessId: "claude-code",
        busy: false,
        canRefresh: true,
        lastResponseAtMs: 0,
        refreshPromptCache: () => deferred.promise,
      }),
    });
    service.configure({ enabled: true, intervalMinutes: 55, ceilingHours: 8 });
    const tickPromise = service.tick();
    // User explicitly turns keep-alive off while refresh is still in flight.
    service.pause("inflight", "off");
    deferred.resolve({
      ok: true,
      value: {
        refreshedAtUnix: 56 * 60,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 20_000,
        coldCache: true,
      },
    });
    await tickPromise;
    expect(service.status("inflight").threads[0]?.paused).toBe("off");
    service.stop();
  });

  it("probes once after reload when seeded idle exceeds TTL within ceiling, continuing if warm and pausing if cold", async () => {
    // Simulate a Host restart 75 minutes after the last persisted assistant turn (previous
    // keep-alive refresh was non-persisted at 55m, so the cache may still be warm).
    vi.setSystemTime(75 * MINUTE);
    const watches = new Map([
      ["warm-reloaded", 1],
      ["cold-reloaded", 1],
    ]);
    const warmRefresh = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          refreshedAtUnix: 75 * 60,
          cacheReadInputTokens: 40_000,
          cacheCreationInputTokens: 40,
          coldCache: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          refreshedAtUnix: 130 * 60,
          cacheReadInputTokens: 40_000,
          cacheCreationInputTokens: 40,
          coldCache: false,
        },
      });
    const coldRefresh = vi.fn().mockResolvedValueOnce({
      ok: true as const,
      value: {
        refreshedAtUnix: 75 * 60,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 40_000,
        coldCache: true,
      },
    });
    const service = new PromptCacheKeepAliveService({
      activeWatchCounts: () => watches,
      resolveTarget: (threadId) => ({
        threadId,
        harnessId: "claude-code",
        busy: false,
        canRefresh: true,
        lastResponseAtMs: 0,
        refreshPromptCache: threadId === "warm-reloaded" ? warmRefresh : coldRefresh,
      }),
    });
    service.configure({ enabled: true, intervalMinutes: 55, ceilingHours: 8 });

    // First tick probes both threads past 60m TTL.
    await service.tick();
    expect(warmRefresh).toHaveBeenCalledTimes(1);
    expect(coldRefresh).toHaveBeenCalledTimes(1);
    expect(service.status("warm-reloaded").threads[0]).toMatchObject({
      paused: null,
      lastDecision: "refreshed",
      refreshes: 1,
    });
    expect(service.status("cold-reloaded").threads[0]).toMatchObject({
      paused: "cold-cache",
      lastDecision: "refreshed-cold",
      refreshes: 1,
    });

    // Warm thread continues normal 55m keep-alive cadence; cold thread stays paused.
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(warmRefresh).toHaveBeenCalledTimes(2);
    expect(coldRefresh).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("forgets keep-alive state on thread deletion and protects watched threads on secondary Host instances", async () => {
    vi.useRealTimers();
    let watchedThreadId: string | null = null;
    const listeners = new Set<() => void>();
    const watchObserver = {
      activeWatchCountsBySubscriber: () =>
        watchedThreadId ? new Map([[watchedThreadId, 1]]) : new Map<string, number>(),
      hasActiveWatchesFor: (id: string) => watchedThreadId === id,
      onWatchesChanged: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      delegationWatchObserver: watchObserver,
    });
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      // Before turn completes, keep-alive has not recorded a completed response yet.
      expect(
        (await fixture.host.promptCacheKeepAliveApi.keepAlive({ threadId })).threads[0]
          ?.lastRequestAt,
      ).toBeNull();
      const session = adapter.sessions[0];
      if (!session) throw new Error("Missing fake session");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

      await vi.waitFor(async () => {
        const status = await fixture.host.promptCacheKeepAliveApi.keepAlive({ threadId });
        expect(status.threads[0]?.lastRequestAt).not.toBeNull();
      });

      // Enable idle release so loaded-sessions reports canRelease protection.
      writeRequest(fixture.desktopInput, {
        id: 900,
        method: IDLE_RELEASE_SETTINGS_METHOD,
        params: { enabled: true, timeoutMinutes: 10 },
      });
      await fixture.collector.waitFor((msg) => msg.id === 900);

      // Active watch on this Host protects the idle thread from idle release.
      watchedThreadId = threadId;
      for (const listener of listeners) listener();
      writeRequest(fixture.desktopInput, {
        id: 901,
        method: LOADED_SESSIONS_METHOD,
        params: {},
      });
      const loadedWhileWatched = await fixture.collector.waitFor((msg) => msg.id === 901);
      expect(loadedWhileWatched.result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadId, state: "busy", reason: "background" }),
        ]),
      );

      // Clearing the watch drops the background protection.
      watchedThreadId = null;
      writeRequest(fixture.desktopInput, {
        id: 9011,
        method: LOADED_SESSIONS_METHOD,
        params: {},
      });
      const loadedAfterWatch = await fixture.collector.waitFor((msg) => msg.id === 9011);
      expect(loadedAfterWatch.result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadId, state: "idle", reason: "timeout" }),
        ]),
      );

      // Deleting the thread forgets its keep-alive entry.
      writeRequest(fixture.desktopInput, {
        id: 902,
        method: "thread/delete",
        params: { threadId },
      });
      await fixture.collector.waitFor((msg) => msg.id === 902);
      const afterDelete = await fixture.host.promptCacheKeepAliveApi.keepAlive({});
      expect(afterDelete.threads.some((entry) => entry.threadId === threadId)).toBe(false);
    } finally {
      await stopFixture(fixture);
    }
  });
});
