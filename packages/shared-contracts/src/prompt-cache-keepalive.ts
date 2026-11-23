import { z } from "zod";

export const PROMPT_CACHE_KEEPALIVE_INTERVAL_MINUTES_MIN = 1;
export const PROMPT_CACHE_KEEPALIVE_INTERVAL_MINUTES_MAX = 59;
export const PROMPT_CACHE_KEEPALIVE_INTERVAL_MINUTES_DEFAULT = 55;

export const PROMPT_CACHE_KEEPALIVE_CEILING_HOURS_MIN = 1;
export const PROMPT_CACHE_KEEPALIVE_CEILING_HOURS_MAX = 48;
export const PROMPT_CACHE_KEEPALIVE_CEILING_HOURS_DEFAULT = 8;

export const promptCacheKeepAliveSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  intervalMinutes: z
    .number()
    .int()
    .min(PROMPT_CACHE_KEEPALIVE_INTERVAL_MINUTES_MIN)
    .max(PROMPT_CACHE_KEEPALIVE_INTERVAL_MINUTES_MAX),
  ceilingHours: z
    .number()
    .int()
    .min(PROMPT_CACHE_KEEPALIVE_CEILING_HOURS_MIN)
    .max(PROMPT_CACHE_KEEPALIVE_CEILING_HOURS_MAX),
});

export type PromptCacheKeepAliveSettings = z.infer<typeof promptCacheKeepAliveSettingsSchema>;

export const DEFAULT_PROMPT_CACHE_KEEPALIVE_SETTINGS: Readonly<PromptCacheKeepAliveSettings> =
  Object.freeze({
    enabled: false,
    intervalMinutes: PROMPT_CACHE_KEEPALIVE_INTERVAL_MINUTES_DEFAULT,
    ceilingHours: PROMPT_CACHE_KEEPALIVE_CEILING_HOURS_DEFAULT,
  });
