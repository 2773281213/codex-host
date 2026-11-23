import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Options as ClaudeSdkOptions,
  Query,
  query as claudeSdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { harnessThinkingOptionIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";

import { ClaudeCodeAdapter } from "../src/index.js";
import {
  CLAUDE_PROMPT_CACHE_KEEPALIVE_PROMPT,
  claudePromptCacheKeepAliveBlockReason,
  claudePromptCacheModelFamily,
  isColdPromptCache,
} from "../src/claude-prompt-cache.js";
import { encodeClaudeModelRef } from "../src/model-catalog.js";
import { ClaudeSdkTransport } from "../src/sdk-transport.js";
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
        requestId: "msg_keepalive_warm",
        model: "claude-opus-4-6",
        usage: {
          cache_read_input_tokens: 64_000,
          cache_creation_input_tokens: 128,
          cache_creation: { ephemeral_1h_input_tokens: 128 },
          input_tokens: 16,
          output_tokens: 2,
        },
      })
      .mockResolvedValueOnce({
        requestId: "msg_keepalive_cold",
        model: "claude-opus-4-6",
        usage: {
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 64_000,
          input_tokens: 16,
          output_tokens: 2,
        },
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

    // Refresh usage is metered through standard usage.request events via claudeUsageRecord.
    const usageRequests = events.filter(
      (output) => output.kind === "event" && output.event.type === "usage.request",
    );
    expect(
      usageRequests.some(
        (output) =>
          output.kind === "event" &&
          output.event.type === "usage.request" &&
          output.event.request.requestId === "msg_keepalive_warm" &&
          output.event.request.model === "claude-opus-4-6" &&
          output.event.request.cachedInputTokens === 64_000 &&
          output.event.request.cacheWriteInputTokens === 128 &&
          output.event.request.cacheWrite1hInputTokens === 128 &&
          output.event.request.inputTokens === 64_144 &&
          output.event.request.outputTokens === 2,
      ),
    ).toBe(true);

    // Closed session rejects further refresh attempts.
    const afterClose = await session.refreshPromptCache?.();
    expect(afterClose?.ok).toBe(false);
    await adapter.close();
  });

  it("denies tool execution via PreToolUse hook during forked keep-alive without mutating tool definitions", async () => {
    const capturedOptions: ClaudeSdkOptions[] = [];
    const queryFactory = vi.fn((params: { prompt: unknown; options?: ClaudeSdkOptions }) => {
      const options = params.options ?? {};
      capturedOptions.push(options);
      const isFork = options.forkSession === true;
      const messages = isFork
        ? [
            {
              type: "assistant",
              message: {
                id: "msg_keepalive_1",
                model: "claude-opus-4-6",
                usage: {
                  input_tokens: 12,
                  output_tokens: 2,
                  cache_read_input_tokens: 48_000,
                  cache_creation_input_tokens: 64,
                  cache_creation: { ephemeral_1h_input_tokens: 64 },
                },
              },
            },
            {
              type: "result",
              uuid: "res_1",
              is_error: false,
              usage: {
                input_tokens: 12,
                output_tokens: 2,
                cache_read_input_tokens: 48_000,
                cache_creation_input_tokens: 64,
                cache_creation: { ephemeral_1h_input_tokens: 64 },
              },
            },
          ]
        : [];
      const fakeQuery = {
        initializationResult: async () => ({ commands: [] }),
        accountInfo: async () => ({}),
        close: () => undefined,
        async *[Symbol.asyncIterator]() {
          for (const msg of messages) yield msg;
        },
      };
      return fakeQuery as unknown as Query;
    });

    const transport = new ClaudeSdkTransport({
      command: "claude",
      cwd: "/repo",
      sessionId: "sess-1",
      openMode: "resume",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      closeTimeoutMs: 1_000,
      onPermissionModeChanged: () => undefined,
      onFault: () => undefined,
      onPlanLimit: () => undefined,
      queryFactory: queryFactory as unknown as typeof claudeSdkQuery,
    });

    await transport.start();
    const usage = await transport.refreshPromptCache();
    expect(usage).toEqual({
      usage: {
        input_tokens: 12,
        output_tokens: 2,
        cache_read_input_tokens: 48_000,
        cache_creation_input_tokens: 64,
        cache_creation: { ephemeral_1h_input_tokens: 64 },
      },
      requestId: "msg_keepalive_1",
      model: "claude-opus-4-6",
    });

    const forkOptions = capturedOptions[1];
    expect(forkOptions).toBeDefined();
    // Tool definitions stay untouched so the prompt-cache prefix matches.
    expect(forkOptions?.tools).toBeUndefined();
    expect(forkOptions?.disallowedTools).toBeUndefined();
    expect(forkOptions?.forkSession).toBe(true);
    expect(forkOptions?.persistSession).toBe(false);
    const preToolUseHook = forkOptions?.hooks?.PreToolUse?.[0]?.hooks?.[0];
    expect(preToolUseHook).toBeTypeOf("function");
    const decision = await preToolUseHook?.(
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-1",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        tool_use_id: "toolu_1",
      },
      "toolu_1",
      { signal: new AbortController().signal },
    );
    expect(decision).toEqual({
      continue: false,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Tool execution is disabled during prompt-cache keep-alive",
      },
    });
    await transport.close();
  });

  it("blocks refresh for Claude Code cache-disable / 5m flags, uses adapter environment, and keeps lastAssistantResponseAtUnix monotonic", async () => {
    expect(claudePromptCacheKeepAliveBlockReason({ CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" })).toContain(
      "5m",
    );
    // CLAUDE_CODE_PROMPT_CACHE_TTL is case-sensitive in Claude Code.
    expect(
      claudePromptCacheKeepAliveBlockReason({ CLAUDE_CODE_PROMPT_CACHE_TTL: "5M" }),
    ).toBeNull();
    expect(claudePromptCacheKeepAliveBlockReason({ DISABLE_PROMPT_CACHING: "1" })).toContain(
      "DISABLE_PROMPT_CACHING",
    );
    expect(claudePromptCacheKeepAliveBlockReason({ DISABLE_PROMPT_CACHING: "yes" })).toContain(
      "DISABLE_PROMPT_CACHING",
    );
    expect(claudePromptCacheKeepAliveBlockReason({ DISABLE_PROMPT_CACHING: " ON " })).toContain(
      "DISABLE_PROMPT_CACHING",
    );
    expect(claudePromptCacheKeepAliveBlockReason({ FORCE_PROMPT_CACHING_5M: "true" })).toContain(
      "FORCE_PROMPT_CACHING_5M",
    );
    expect(
      claudePromptCacheKeepAliveBlockReason({
        FORCE_PROMPT_CACHING_5M: "yes",
        CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
      }),
    ).toContain("FORCE_PROMPT_CACHING_5M");
    expect(claudePromptCacheModelFamily("claude-opus-4-6")).toBe("opus");
    expect(claudePromptCacheModelFamily("anthropic.claude-sonnet-4-20250514-v1:0")).toBe("sonnet");
    expect(claudePromptCacheModelFamily("haiku")).toBe("haiku");
    expect(claudePromptCacheModelFamily("claude-fable-5-1")).toBe("fable");
    expect(claudePromptCacheModelFamily("custom-gateway-model")).toBeNull();
    expect(claudePromptCacheModelFamily(undefined)).toBeNull();

    // Per-model disable flags only match their own family and never act as global switches.
    const modelCases = [
      ["DISABLE_PROMPT_CACHING_OPUS", "claude-opus-4-6", "claude-sonnet-4-5"],
      ["DISABLE_PROMPT_CACHING_SONNET", "claude-sonnet-4-5", "claude-opus-4-6"],
      ["DISABLE_PROMPT_CACHING_HAIKU", "claude-haiku-4-5-20251001", "claude-opus-4-6"],
      ["DISABLE_PROMPT_CACHING_FABLE", "claude-fable-5-1", "claude-sonnet-4-5"],
    ] as const;
    for (const [modelKey, matchingModel, otherModel] of modelCases) {
      expect(claudePromptCacheKeepAliveBlockReason({ [modelKey]: "on" }, matchingModel)).toContain(
        modelKey,
      );
      expect(claudePromptCacheKeepAliveBlockReason({ [modelKey]: "on" }, otherModel)).toBeNull();
      expect(claudePromptCacheKeepAliveBlockReason({ [modelKey]: "on" })).toBeNull();
    }
    expect(
      claudePromptCacheKeepAliveBlockReason({ CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }),
    ).toBeNull();
    expect(claudePromptCacheKeepAliveBlockReason({})).toBeNull();

    vi.useFakeTimers();
    // Session's native transcript already has a response at 10:30:00, newer than system clock 10:00:00.
    vi.setSystemTime(new Date("2026-11-20T10:00:00.000Z"));
    const newerResponseUnix = Math.floor(Date.parse("2026-11-20T10:30:00.000Z") / 1000);
    const refreshMock = vi.fn<() => Promise<ClaudePromptCacheRefreshUsage>>(async () => ({
      model: "claude-opus-4-6",
      usage: {
        cache_read_input_tokens: 32_000,
        cache_creation_input_tokens: 32,
        input_tokens: 10,
        output_tokens: 2,
      },
    }));

    const baseDeps: ClaudeAdapterDependencies = {
      bypassPermissionsAvailable: () => false,
      createInspector: () => ({
        inspect: async () => ({
          models: [],
          canSelectModel: true,
          canSelectPermissionMode: true,
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
          type: "assistant",
          uuid: "a-newer",
          timestamp: "2026-11-20T10:30:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "newer" }] },
        },
      ],
      readSubagentMessages: async () => [],
      randomUUID: () => "sess-env",
    };

    // Adapter-level environment applies even when open() omits input.environment.
    const envAdapter = new ClaudeCodeAdapter(
      { environment: { FORCE_PROMPT_CACHING_5M: "yes" } },
      baseDeps,
    );
    const adapterBlockedOpen = await envAdapter.open({
      kind: "resume",
      cwd: "/repo",
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "claude-code",
        nativeSessionId: "sess-adapter-env",
        formatVersion: 1,
      }),
    });
    expect(adapterBlockedOpen.ok).toBe(true);
    if (!adapterBlockedOpen.ok) throw new Error(adapterBlockedOpen.error.message);
    expect(await adapterBlockedOpen.value.refreshPromptCache?.()).toMatchObject({
      ok: false,
      error: { code: "unsupported", retryable: false },
    });
    expect(refreshMock).not.toHaveBeenCalled();
    await adapterBlockedOpen.value.close();
    await envAdapter.close();

    // Per-model disable flag blocks only a session running that model family.
    expect(
      claudePromptCacheKeepAliveBlockReason({ DISABLE_PROMPT_CACHING_OPUS: "1" }, "opus[1m]"),
    ).toContain("DISABLE_PROMPT_CACHING_OPUS");
    expect(
      claudePromptCacheKeepAliveBlockReason({ DISABLE_PROMPT_CACHING_SONNET: "1" }, "sonnet[1m]"),
    ).toContain("DISABLE_PROMPT_CACHING_SONNET");
    expect(
      claudePromptCacheKeepAliveBlockReason({ DISABLE_PROMPT_CACHING_HAIKU: "1" }, "opus[1m]"),
    ).toBeNull();

    const perModelAdapter = new ClaudeCodeAdapter(
      { environment: { DISABLE_PROMPT_CACHING_HAIKU: "1" } },
      baseDeps,
    );
    const opusOpen = await perModelAdapter.open({
      kind: "resume",
      cwd: "/repo",
      model: encodeClaudeModelRef("claude-opus-4-6"),
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "claude-code",
        nativeSessionId: "sess-opus",
        formatVersion: 1,
      }),
    });
    expect(opusOpen.ok).toBe(true);
    if (!opusOpen.ok) throw new Error(opusOpen.error.message);
    expect((await opusOpen.value.refreshPromptCache?.())?.ok).toBe(true);
    await opusOpen.value.close();

    const haikuOpen = await perModelAdapter.open({
      kind: "resume",
      cwd: "/repo",
      model: encodeClaudeModelRef("claude-haiku-4-5-20251001"),
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "claude-code",
        nativeSessionId: "sess-haiku",
        formatVersion: 1,
      }),
    });
    expect(haikuOpen.ok).toBe(true);
    if (!haikuOpen.ok) throw new Error(haikuOpen.error.message);
    expect(await haikuOpen.value.refreshPromptCache?.()).toMatchObject({
      ok: false,
      error: { code: "unsupported", retryable: false },
    });
    await haikuOpen.value.close();
    await perModelAdapter.close();

    refreshMock.mockClear();
    const adapter = new ClaudeCodeAdapter({}, baseDeps);
    // 5m TTL env blocks refresh before touching transport.
    const blockedOpen = await adapter.open({
      kind: "resume",
      cwd: "/repo",
      environment: { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" },
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "claude-code",
        nativeSessionId: "sess-5m",
        formatVersion: 1,
      }),
    });
    expect(blockedOpen.ok).toBe(true);
    if (!blockedOpen.ok) throw new Error(blockedOpen.error.message);
    const blocked = await blockedOpen.value.refreshPromptCache?.();
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: "unsupported", retryable: false },
    });
    expect(refreshMock).not.toHaveBeenCalled();
    await blockedOpen.value.close();

    // Monotonic timestamp: refresh started at 10:00 does not regress 10:30 lastAssistantResponseAtUnix.
    const monoOpen = await adapter.open({
      kind: "resume",
      cwd: "/repo",
      environment: { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" },
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "claude-code",
        nativeSessionId: "sess-mono",
        formatVersion: 1,
      }),
    });
    expect(monoOpen.ok).toBe(true);
    if (!monoOpen.ok) throw new Error(monoOpen.error.message);
    const session = monoOpen.value as typeof monoOpen.value & {
      lastAssistantResponseAtUnix?: number;
    };
    expect(session.lastAssistantResponseAtUnix).toBe(newerResponseUnix);
    const refreshed = await session.refreshPromptCache?.();
    expect(refreshed?.ok).toBe(true);
    expect(session.lastAssistantResponseAtUnix).toBe(newerResponseUnix);
    await session.close();
    await adapter.close();
  });
});
