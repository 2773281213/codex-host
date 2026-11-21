import {
  DEFAULT_PROMPT_CACHE_KEEPALIVE_SETTINGS,
  promptCacheKeepAliveSettingsSchema,
  type PromptCacheKeepAliveSettings,
} from "@codexhost/shared-contracts";
import type { RendererModelClient } from "./renderer-model-client.js";
import {
  HARNESS_PREFERENCES_UPDATED_EVENT,
  rendererHarnessPreferences,
  rendererHarnessPreferenceStatus,
  writeRendererHarnessPreferences,
} from "./renderer-harness-preferences.js";

export const PROMPT_CACHE_KEEPALIVE_CHANGE_EVENT = "codexhost:prompt-cache-keepalive-changed";
export const PROMPT_CACHE_KEEPALIVE_STATUS_EVENT = "codexhost:prompt-cache-keepalive-status";
export type PromptCacheKeepAliveSyncStatus = "pending" | "applied" | "unavailable" | "failed";

export function readPromptCacheKeepAlivePreference(owner: Window): PromptCacheKeepAliveSettings {
  void owner;
  return {
    ...(rendererHarnessPreferences()?.values.promptCacheKeepAlive ??
      DEFAULT_PROMPT_CACHE_KEEPALIVE_SETTINGS),
  };
}

export function writePromptCacheKeepAlivePreference(
  owner: Window,
  value: PromptCacheKeepAliveSettings,
): boolean {
  const parsed = promptCacheKeepAliveSettingsSchema.safeParse(value);
  if (
    !parsed.success ||
    !rendererHarnessPreferences() ||
    rendererHarnessPreferenceStatus() === "unavailable"
  ) {
    return false;
  }
  void writeRendererHarnessPreferences(owner, "local", [
    { kind: "promptCacheKeepAlive", value: parsed.data },
  ]).catch(() => {});
  return true;
}

/** Settings controls observe confirmed Host policy; reconnect never pushes a browser cache. */
export function installPromptCacheKeepAlivePreferenceSync(owner: Window) {
  let disposed = false;
  const publish = () => {
    if (disposed) return;
    owner.dispatchEvent(
      new CustomEvent(PROMPT_CACHE_KEEPALIVE_STATUS_EVENT, {
        detail: rendererHarnessPreferenceStatus(),
      }),
    );
    owner.dispatchEvent(new Event(PROMPT_CACHE_KEEPALIVE_CHANGE_EVENT));
  };
  const changed = () => publish();
  owner.addEventListener(HARNESS_PREFERENCES_UPDATED_EVENT, changed);
  return {
    connect(client: RendererModelClient | null) {
      void client;
      publish();
    },
    dispose() {
      disposed = true;
      owner.removeEventListener(HARNESS_PREFERENCES_UPDATED_EVENT, changed);
    },
  };
}
