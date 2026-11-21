// @vitest-environment jsdom
import {
  DEFAULT_PROMPT_CACHE_KEEPALIVE_SETTINGS,
  type HarnessPreferencePatch,
  type HarnessPreferenceSnapshot,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installRendererHarnessPreferenceSync } from "../../src/renderer-harness-preferences.js";
import type { RendererModelClient } from "../../src/renderer-model-client.js";
import { installPromptCacheKeepAlivePreferenceSync } from "../../src/renderer-prompt-cache-keepalive-preference.js";
import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import { mountPromptCacheKeepAliveControls } from "../../src/settings/prompt-cache-keepalive-controls.js";

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Prompt cache keep-alive settings controls", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
    document.body.innerHTML = "";
  });

  it("renders confirmed Host settings, validates bounds, and patches updates", async () => {
    let revision = 1;
    let current = { ...DEFAULT_PROMPT_CACHE_KEEPALIVE_SETTINGS };
    const patches: HarnessPreferencePatch[] = [];
    const client = {
      getHarnessPreferences: vi.fn(async (): Promise<HarnessPreferenceSnapshot> => ({
        scope: "external",
        revision,
        values: {
          favorites: {},
          promptCacheKeepAlive: { ...current },
        },
      })),
      patchHarnessPreferences: vi.fn(
        async (input: HarnessPreferencePatch): Promise<HarnessPreferenceSnapshot> => {
          patches.push(input);
          for (const op of input.operations) {
            if (op.kind === "promptCacheKeepAlive") {
              current = { ...op.value };
            }
          }
          revision += 1;
          return {
            scope: "external",
            revision,
            values: {
              favorites: {},
              promptCacheKeepAlive: { ...current },
            },
          };
        },
      ),
    } as unknown as RendererModelClient;

    const preferences = installRendererHarnessPreferenceSync(window);
    const keepAliveSync = installPromptCacheKeepAlivePreferenceSync(window);
    disposers.push(
      () => keepAliveSync.dispose(),
      () => preferences.dispose(),
    );
    preferences.connect("local", client);
    keepAliveSync.connect(client);
    await flushMicrotasks();

    const content = document.createElement("div");
    document.body.append(content);
    const scope = new RendererSettingsPageScope();
    const dispose = mountPromptCacheKeepAliveControls(
      {
        content,
        signal: scope.signal,
        runLatest: (op, handlers) => scope.runLatest(op, handlers),
      },
      rendererSettingsMessages("en"),
    );
    disposers.push(dispose, () => scope.dispose());

    const checkbox = content.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const numberInputs = [
      ...content.querySelectorAll('input[type="number"]'),
    ] as HTMLInputElement[];
    expect(checkbox).toBeTruthy();
    expect(numberInputs).toHaveLength(2);
    const [intervalInput, ceilingInput] = numberInputs as [HTMLInputElement, HTMLInputElement];

    expect(checkbox.checked).toBe(true);
    expect(intervalInput.value).toBe("55");
    expect(ceilingInput.value).toBe("8");

    // Reject out-of-range interval without patching Host.
    intervalInput.value = "90";
    intervalInput.dispatchEvent(new Event("change"));
    expect(intervalInput.getAttribute("aria-invalid")).toBe("true");
    expect(patches).toHaveLength(0);

    // Valid interval updates Host preference.
    intervalInput.value = "45";
    intervalInput.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(intervalInput.getAttribute("aria-invalid")).toBe("false");
    expect(patches.at(-1)?.operations).toEqual([
      {
        kind: "promptCacheKeepAlive",
        value: { enabled: true, intervalMinutes: 45, ceilingHours: 8 },
      },
    ]);

    // Valid ceiling hours updates Host preference.
    ceilingInput.value = "12";
    ceilingInput.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(patches.at(-1)?.operations).toEqual([
      {
        kind: "promptCacheKeepAlive",
        value: { enabled: true, intervalMinutes: 45, ceilingHours: 12 },
      },
    ]);

    // Disabling hides interval and ceiling rows and persists enabled: false.
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(patches.at(-1)?.operations).toEqual([
      {
        kind: "promptCacheKeepAlive",
        value: { enabled: false, intervalMinutes: 45, ceilingHours: 12 },
      },
    ]);
    const intervalRow = intervalInput.closest("div.flex.min-h-\\[60px\\]") as HTMLElement;
    const ceilingRow = ceilingInput.closest("div.flex.min-h-\\[60px\\]") as HTMLElement;
    expect(intervalRow.hidden).toBe(true);
    expect(ceilingRow.hidden).toBe(true);
  });

  it("shows unavailable state when preference owner is disconnected", () => {
    const preferences = installRendererHarnessPreferenceSync(window);
    const keepAliveSync = installPromptCacheKeepAlivePreferenceSync(window);
    disposers.push(
      () => keepAliveSync.dispose(),
      () => preferences.dispose(),
    );
    preferences.connect("local", null);
    keepAliveSync.connect(null);

    const content = document.createElement("div");
    document.body.append(content);
    const scope = new RendererSettingsPageScope();
    const dispose = mountPromptCacheKeepAliveControls(
      {
        content,
        signal: scope.signal,
        runLatest: (op, handlers) => scope.runLatest(op, handlers),
      },
      rendererSettingsMessages("zh-CN"),
    );
    disposers.push(dispose, () => scope.dispose());

    const status = content.querySelector('[role="status"]') as HTMLElement;
    expect(status.textContent).toBe("当前 Host 不支持");
  });
});
