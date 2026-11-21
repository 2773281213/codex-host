import type { HostUsage } from "@codexhost/harness-adapter";

/** Minimal prompt sent on an ephemeral forked query to refresh Claude's 1-hour cache prefix. */
export const CLAUDE_PROMPT_CACHE_KEEPALIVE_PROMPT =
  "codexhost prompt-cache keep-alive: no action is needed. Reply with the single word OK.";

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
