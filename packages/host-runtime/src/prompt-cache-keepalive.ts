import {
  DEFAULT_PROMPT_CACHE_KEEPALIVE_SETTINGS,
  promptCacheKeepAliveSettingsSchema,
  type PromptCacheKeepAliveSettings,
} from "@codexhost/shared-contracts";
import type { HarnessResult, PromptCacheRefreshResult } from "@codexhost/harness-adapter";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Anthropic 1-hour prompt-cache lifetime, counted from request start. */
export const PROMPT_CACHE_TTL_MS = 60 * MINUTE_MS;
/** Backoff applied after a transient refresh failure. */
export const PROMPT_CACHE_RETRY_BACKOFF_MS = 5 * MINUTE_MS;
export const PROMPT_CACHE_CHECK_INTERVAL_MS = MINUTE_MS;

export type PromptCacheKeepAliveDecision =
  | "refresh"
  | "disabled"
  | "paused"
  | "no-watches"
  | "busy"
  | "no-request"
  | "ceiling"
  | "cold"
  | "backoff"
  | "not-due";

export interface PromptCacheKeepAliveDecisionInput {
  now: number;
  watchedCount: number;
  busy: boolean;
  enabled: boolean;
  lastRequestAt: number | null;
  lastRefreshAt: number | null;
  retryAfter: number | null;
  paused: string | null;
  intervalMs: number;
  ttlMs: number;
  ceilingMs: number;
  /**
   * When true, permits one probe refresh past `ttlMs` (still within `ceilingMs`)
   * for a session seeded from native history whose prior non-persisted refreshes
   * are unknown after a Host restart or reconnect.
   */
  allowReloadProbe?: boolean;
}

/**
 * Pure keep-alive decision engine ported from agenthub-relay:
 * refreshes only while watched delegations run, the planner Thread is idle,
 * the cache is presumed warm (idle < TTL, or a single post-reload probe),
 * the refresh interval has elapsed, and the planner's last real request is
 * within the configured ceiling.
 */
export function decidePromptCacheKeepAlive(
  input: PromptCacheKeepAliveDecisionInput,
): PromptCacheKeepAliveDecision {
  if (!input.enabled) return "disabled";
  if (input.paused !== null) return "paused";
  if (input.watchedCount <= 0) return "no-watches";
  if (input.busy) return "busy";
  if (input.lastRequestAt === null) return "no-request";
  if (input.now - input.lastRequestAt >= input.ceilingMs) return "ceiling";
  const idleMs = input.now - Math.max(input.lastRequestAt, input.lastRefreshAt ?? 0);
  if (idleMs >= input.ttlMs && !input.allowReloadProbe) return "cold";
  if (input.retryAfter !== null && input.now < input.retryAfter) return "backoff";
  if (idleMs < input.intervalMs) return "not-due";
  return "refresh";
}

export interface PromptCacheKeepAliveCompaction {
  at: number;
  trigger?: string;
}

export interface PromptCacheKeepAliveThreadState {
  threadId: string;
  harnessId?: string;
  watchedCount: number;
  lastRequestAt: number | null;
  lastRefreshAt: number | null;
  retryAfter: number | null;
  refreshes: number;
  lastCacheReadTokens: number | null;
  lastCacheWriteTokens: number | null;
  paused: string | null;
  lastDecision: string | null;
  compactions: PromptCacheKeepAliveCompaction[];
}

export interface PromptCacheKeepAliveStatus {
  settings: PromptCacheKeepAliveSettings;
  globalPaused: string | null;
  threads: PromptCacheKeepAliveThreadState[];
}

export interface PromptCacheKeepAliveTarget {
  threadId: string;
  harnessId: string;
  busy: boolean;
  canRefresh: boolean;
  /** Adapter-reported timestamp (Unix ms) of the last real assistant response, if known. */
  lastResponseAtMs?: number | null;
  refreshPromptCache(): Promise<HarnessResult<PromptCacheRefreshResult>>;
}

interface InternalThreadState {
  lastRequestAt: number | null;
  lastRefreshAt: number | null;
  retryAfter: number | null;
  refreshes: number;
  lastCacheReadTokens: number | null;
  lastCacheWriteTokens: number | null;
  paused: string | null;
  lastDecision: string | null;
  compactions: PromptCacheKeepAliveCompaction[];
  refreshing: boolean;
  seededFromAdapter: boolean;
}

const MAX_COMPACTIONS_PER_THREAD = 20;
const PERSISTENT_PAUSE_REASONS = new Set(["off", "cold-cache", "cache-disabled"]);

/**
 * Host-managed prompt-cache keep-alive scheduler.
 * Runs lazily on a 1-minute interval ONLY while at least one Thread has active
 * watches waiting on delegated children, keeping idle Claude Code planners warm
 * across long delegations without polluting their conversation transcript.
 */
export class PromptCacheKeepAliveService {
  readonly #threads = new Map<string, InternalThreadState>();
  #settings: PromptCacheKeepAliveSettings = { ...DEFAULT_PROMPT_CACHE_KEEPALIVE_SETTINGS };
  #globalPaused: string | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  #stopped = false;

  constructor(
    private readonly options: {
      activeWatchCounts(): ReadonlyMap<string, number>;
      resolveTarget(threadId: string): PromptCacheKeepAliveTarget | undefined;
      diagnose?(message: string): void;
      now?: () => number;
    },
  ) {}

  get settings(): PromptCacheKeepAliveSettings {
    return { ...this.#settings };
  }

  configure(value: unknown): PromptCacheKeepAliveSettings {
    const parsed = promptCacheKeepAliveSettingsSchema.parse(value);
    this.#settings = parsed;
    this.syncTimer();
    return { ...parsed };
  }

  recordRequest(threadId: string, at = this.#now()): void {
    const state = this.#ensure(threadId);
    state.lastRequestAt = at;
    state.retryAfter = null;
    state.seededFromAdapter = false;
    // Clear transient pauses on a new real turn, while preserving persistent reasons
    // (explicit user "off", 5m TTL "cold-cache", and "cache-disabled").
    if (state.paused !== null && !PERSISTENT_PAUSE_REASONS.has(state.paused)) {
      state.paused = null;
    }
    this.syncTimer();
  }

  recordCompaction(threadId: string, trigger?: string, at = this.#now()): void {
    const state = this.#ensure(threadId);
    state.compactions = [...state.compactions, { at, ...(trigger ? { trigger } : {}) }].slice(
      -MAX_COMPACTIONS_PER_THREAD,
    );
  }

  pause(threadId?: string, reason = "off"): void {
    if (threadId) {
      this.#ensure(threadId).paused = reason;
    } else {
      this.#globalPaused = reason;
    }
    this.syncTimer();
  }

  resume(threadId?: string): void {
    if (threadId) {
      const state = this.#ensure(threadId);
      state.paused = null;
      state.retryAfter = null;
    } else {
      this.#globalPaused = null;
      for (const state of this.#threads.values()) {
        state.paused = null;
        state.retryAfter = null;
      }
    }
    this.syncTimer();
  }

  forget(threadId: string, options: { preserveUserPause?: boolean } = {}): void {
    if (options.preserveUserPause) {
      const existing = this.#threads.get(threadId);
      if (existing?.paused === "off") {
        this.#threads.set(threadId, {
          lastRequestAt: null,
          lastRefreshAt: null,
          retryAfter: null,
          refreshes: 0,
          lastCacheReadTokens: null,
          lastCacheWriteTokens: null,
          paused: "off",
          lastDecision: null,
          compactions: [],
          refreshing: false,
          seededFromAdapter: false,
        });
        this.syncTimer();
        return;
      }
    }
    this.#threads.delete(threadId);
    this.syncTimer();
  }

  status(threadId?: string): PromptCacheKeepAliveStatus {
    const counts = this.options.activeWatchCounts();
    const ids = threadId
      ? [threadId]
      : [...new Set([...this.#threads.keys(), ...counts.keys()])].sort();
    const threads: PromptCacheKeepAliveThreadState[] = ids.map((id) => {
      const state = this.#threads.get(id);
      const target = this.options.resolveTarget(id);
      const lastRequestAt = state?.lastRequestAt ?? target?.lastResponseAtMs ?? null;
      return {
        threadId: id,
        ...(target?.harnessId ? { harnessId: target.harnessId } : {}),
        watchedCount: counts.get(id) ?? 0,
        lastRequestAt,
        lastRefreshAt: state?.lastRefreshAt ?? null,
        retryAfter: state?.retryAfter ?? null,
        refreshes: state?.refreshes ?? 0,
        lastCacheReadTokens: state?.lastCacheReadTokens ?? null,
        lastCacheWriteTokens: state?.lastCacheWriteTokens ?? null,
        paused: state?.paused ?? this.#globalPaused,
        lastDecision: state?.lastDecision ?? null,
        compactions: state ? [...state.compactions] : [],
      };
    });
    return {
      settings: { ...this.#settings },
      globalPaused: this.#globalPaused,
      threads,
    };
  }

  /** Starts the 1-minute check timer only when enabled and at least one watch is active. */
  syncTimer(): void {
    if (this.#stopped) return;
    const counts = this.options.activeWatchCounts();
    const hasActiveWatches = [...counts.values()].some((count) => count > 0);
    const shouldRun = this.#settings.enabled && this.#globalPaused === null && hasActiveWatches;
    if (shouldRun && !this.#timer) {
      this.#timer = setInterval(() => {
        void this.tick();
      }, PROMPT_CACHE_CHECK_INTERVAL_MS);
      this.#timer.unref?.();
    } else if (!shouldRun && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.#stopped || this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      const counts = this.options.activeWatchCounts();
      const candidateIds = new Set<string>([...counts.keys(), ...this.#threads.keys()]);
      for (const threadId of candidateIds) {
        if (this.#stopped) return;
        const watchedCount = counts.get(threadId) ?? 0;
        const target = this.options.resolveTarget(threadId);
        if (!target || !target.canRefresh) continue;
        const state = this.#ensure(threadId);
        if (state.refreshing) continue;
        if (
          state.lastRequestAt === null &&
          typeof target.lastResponseAtMs === "number" &&
          Number.isFinite(target.lastResponseAtMs)
        ) {
          state.lastRequestAt = target.lastResponseAtMs;
          state.seededFromAdapter = true;
        }
        const decision = decidePromptCacheKeepAlive({
          now,
          watchedCount,
          busy: target.busy,
          enabled: this.#settings.enabled,
          lastRequestAt: state.lastRequestAt,
          lastRefreshAt: state.lastRefreshAt,
          retryAfter: state.retryAfter,
          paused: this.#globalPaused ?? state.paused,
          intervalMs: this.#settings.intervalMinutes * MINUTE_MS,
          ttlMs: PROMPT_CACHE_TTL_MS,
          ceilingMs: this.#settings.ceilingHours * HOUR_MS,
          allowReloadProbe:
            state.seededFromAdapter && state.refreshes === 0 && state.lastRefreshAt === null,
        });
        if (decision !== "refresh") {
          state.lastDecision = decision;
          continue;
        }
        // Consume any one-shot reload probe before awaiting refresh so a failed probe
        // falls back to normal TTL cold detection rather than retrying past TTL until ceiling.
        state.seededFromAdapter = false;
        state.refreshing = true;
        try {
          const result = await target.refreshPromptCache();
          if (result.ok) {
            state.lastRefreshAt = now;
            state.retryAfter = null;
            state.refreshes += 1;
            state.lastCacheReadTokens = result.value.cacheReadInputTokens;
            state.lastCacheWriteTokens = result.value.cacheCreationInputTokens;
            const cacheDisabled =
              result.value.cacheReadInputTokens === 0 &&
              result.value.cacheCreationInputTokens === 0 &&
              (result.value.inputTokens ?? 0) > 0;
            if (cacheDisabled) {
              if (state.paused !== "off") state.paused = "cache-disabled";
              state.lastDecision = "refreshed-cache-disabled";
              this.options.diagnose?.(
                `prompt-cache keep-alive paused for Thread ${threadId}: refresh reported 0 cache read/write tokens with ${result.value.inputTokens} uncached input tokens, indicating prompt caching is disabled.`,
              );
            } else if (result.value.coldCache) {
              if (state.paused !== "off") state.paused = "cold-cache";
              state.lastDecision = "refreshed-cold";
              this.options.diagnose?.(
                `prompt-cache keep-alive paused for Thread ${threadId}: refresh wrote more tokens (${result.value.cacheCreationInputTokens}) than it read (${result.value.cacheReadInputTokens}), indicating a 5-minute TTL rather than 1-hour TTL. Configure CLAUDE_CODE_PROMPT_CACHE_TTL=1h and resume keep-alive.`,
              );
            } else {
              state.lastDecision = "refreshed";
            }
          } else {
            if (result.error.code === "unsupported") {
              if (state.paused !== "off") state.paused = result.error.code;
              state.retryAfter = null;
            } else {
              state.retryAfter = now + PROMPT_CACHE_RETRY_BACKOFF_MS;
            }
            state.lastDecision = `refresh-${result.error.code}`;
            this.options.diagnose?.(
              `prompt-cache keep-alive failed for Thread ${threadId} (${result.error.code}): ${result.error.message}`,
            );
          }
        } catch (error) {
          state.retryAfter = now + PROMPT_CACHE_RETRY_BACKOFF_MS;
          state.lastDecision = "refresh-error";
          this.options.diagnose?.(
            `prompt-cache keep-alive error for Thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          state.refreshing = false;
        }
      }
    } finally {
      this.#ticking = false;
      this.syncTimer();
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  #ensure(threadId: string): InternalThreadState {
    let state = this.#threads.get(threadId);
    if (!state) {
      state = {
        lastRequestAt: null,
        lastRefreshAt: null,
        retryAfter: null,
        refreshes: 0,
        lastCacheReadTokens: null,
        lastCacheWriteTokens: null,
        paused: null,
        lastDecision: null,
        compactions: [],
        refreshing: false,
        seededFromAdapter: false,
      };
      this.#threads.set(threadId, state);
    }
    return state;
  }
}
