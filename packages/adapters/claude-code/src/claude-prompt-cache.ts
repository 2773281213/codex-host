import type { HostUsage } from "@codexhost/harness-adapter";

/** Minimal prompt sent on an ephemeral forked query to refresh Claude's 1-hour cache prefix. */
export const CLAUDE_PROMPT_CACHE_KEEPALIVE_PROMPT =
  "codexhost prompt-cache keep-alive: no action is needed. Reply with the single word OK.";

export const CLAUDE_PROMPT_CACHE_TTL_ENV = "CLAUDE_CODE_PROMPT_CACHE_TTL";
export const CLAUDE_FORCE_PROMPT_CACHING_5M_ENV = "FORCE_PROMPT_CACHING_5M";
export const CLAUDE_DISABLE_PROMPT_CACHING_ENV = "DISABLE_PROMPT_CACHING";

const CLAUDE_DISABLE_PROMPT_CACHING_BY_FAMILY = {
  opus: "DISABLE_PROMPT_CACHING_OPUS",
  sonnet: "DISABLE_PROMPT_CACHING_SONNET",
  haiku: "DISABLE_PROMPT_CACHING_HAIKU",
  fable: "DISABLE_PROMPT_CACHING_FABLE",
} as const;

type ClaudeModelFamily = keyof typeof CLAUDE_DISABLE_PROMPT_CACHING_BY_FAMILY;

function isTruthyEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** Identifies the Claude model family from a model ID or alias, or null when unknown. */
export function claudePromptCacheModelFamily(model: string | undefined): ClaudeModelFamily | null {
  const value = model?.trim().toLowerCase().replaceAll("_", "-");
  if (!value) return null;
  if (/(?:^|[-./:])opus(?:$|[-./:@[\d])/u.test(value)) return "opus";
  if (/(?:^|[-./:])sonnet(?:$|[-./:@[\d])/u.test(value)) return "sonnet";
  if (/(?:^|[-./:])haiku(?:$|[-./:@[\d])/u.test(value)) return "haiku";
  if (/(?:^|[-./:])fable(?:$|[-./:@[\d])/u.test(value)) return "fable";
  return null;
}

/**
 * Returns a human-readable block reason when environment variables explicitly disable
 * prompt caching or force a 5-minute TTL. Per-model disable flags apply only when the
 * session's model family is known and matches; unknown models rely on the zero-cache
 * usage fallback in the Host scheduler.
 */
export function claudePromptCacheKeepAliveBlockReason(
  environment: NodeJS.ProcessEnv = process.env,
  model?: string,
): string | null {
  if (isTruthyEnvFlag(environment[CLAUDE_FORCE_PROMPT_CACHING_5M_ENV])) {
    return `${CLAUDE_FORCE_PROMPT_CACHING_5M_ENV} is enabled; 1-hour prompt-cache keep-alive is skipped`;
  }
  if (isTruthyEnvFlag(environment[CLAUDE_DISABLE_PROMPT_CACHING_ENV])) {
    return `${CLAUDE_DISABLE_PROMPT_CACHING_ENV} is enabled; prompt-cache keep-alive is skipped`;
  }
  const family = claudePromptCacheModelFamily(model);
  if (family !== null) {
    const modelFlag = CLAUDE_DISABLE_PROMPT_CACHING_BY_FAMILY[family];
    if (isTruthyEnvFlag(environment[modelFlag])) {
      return `${modelFlag} is enabled; prompt-cache keep-alive is skipped`;
    }
  }
  const ttl = environment[CLAUDE_PROMPT_CACHE_TTL_ENV]?.trim();
  if (ttl === "5m") {
    return `${CLAUDE_PROMPT_CACHE_TTL_ENV} is set to 5m; 1-hour prompt-cache keep-alive is skipped`;
  }
  return null;
}

/**
 * A warm prefix is read rather than rewritten; writing more cached prefix than was read
 * indicates the entry had already lapsed (for example under a 5-minute TTL).
 */
export function isColdPromptCache(usage: {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}): boolean {
  return usage.cacheCreationInputTokens > usage.cacheReadInputTokens;
}

/** Main-session native timestamps survive Renderer reloads and Session reopening. */
export function lastClaudeAssistantResponseUnix(messages: readonly unknown[]): number | undefined {
  let latest: number | undefined;
  for (const entry of messages) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("type" in entry) ||
      entry.type !== "assistant" ||
      ("isSidechain" in entry && entry.isSidechain === true) ||
      ("parent_tool_use_id" in entry && entry.parent_tool_use_id != null) ||
      !("timestamp" in entry) ||
      typeof entry.timestamp !== "string"
    )
      continue;
    const time = Math.floor(Date.parse(entry.timestamp) / 1000);
    if (Number.isSafeInteger(time) && time >= 0) latest = Math.max(latest ?? 0, time);
  }
  return latest;
}

export function claudePromptCacheIndicators(
  accountCreditsSupported: boolean,
  lastResponseAtUnix: number | undefined,
): NonNullable<HostUsage["composerIndicators"]> {
  if (!accountCreditsSupported || lastResponseAtUnix === undefined) return [];
  return [
    {
      kind: "countdown",
      id: "prompt-cache",
      expiresAtUnix: lastResponseAtUnix + 3600,
      label: { en: "Prompt cache", "zh-CN": "提示词缓存" },
    },
  ];
}
