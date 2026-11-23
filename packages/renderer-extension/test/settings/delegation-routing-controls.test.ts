// @vitest-environment jsdom
import type {
  DelegationRoutingGetParams,
  DelegationRoutingSetParams,
  DelegationRoutingSnapshot,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RendererSettingsPageScope } from "../../src/settings/core.js";
import {
  mountDelegationRoutingControls,
  type DelegationRoutingClient,
} from "../../src/settings/delegation-routing-controls.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeSnapshot(
  profile: string,
  configuredDefaultProfile: string | null = null,
): DelegationRoutingSnapshot {
  if (profile === "codex-planner") {
    return {
      profile: "codex-planner",
      profileReason: "explicit",
      configuredDefaultProfile,
      availableProfiles: ["thread16", "codex-planner"],
      routes: {
        deep: { harnessId: "claude-code" },
        light: { harnessId: "deepseek-harness" },
        review: { harnessId: "codex" },
      },
      routeSpecs: {
        deep: "claude-code",
        light: "deepseek-harness",
        review: "codex",
      },
      sources: [],
      userConfigPath: "/home/user/.codexhost/delegation-routing.json",
    };
  }
  return {
    profile: "thread16",
    profileReason: "built-in default",
    configuredDefaultProfile,
    availableProfiles: ["thread16", "codex-planner"],
    routes: {
      deep: { harnessId: "codex" },
      light: { harnessId: "deepseek-harness" },
      review: { harnessId: "claude-code" },
    },
    routeSpecs: {
      deep: "codex",
      light: "deepseek-harness",
      review: "claude-code",
    },
    sources: [],
    userConfigPath: "/home/user/.codexhost/delegation-routing.json",
  };
}

describe("Delegation routing settings controls", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
    document.body.innerHTML = "";
  });

  it("separates default profile from editing profile, saves only changed fields, and restores auto", async () => {
    const savedPayloads: DelegationRoutingSetParams[] = [];
    let pinnedDefault: string | null = "thread16";
    const client: DelegationRoutingClient = {
      getDelegationRouting: vi.fn(async (input?: DelegationRoutingGetParams) =>
        makeSnapshot(input?.profile ?? pinnedDefault ?? "thread16", pinnedDefault),
      ),
      setDelegationRouting: vi.fn(async (input: DelegationRoutingSetParams) => {
        savedPayloads.push(input);
        if (input.defaultProfile !== undefined) pinnedDefault = input.defaultProfile;
        const target = input.editProfile ?? input.profile ?? pinnedDefault ?? "thread16";
        const base = makeSnapshot(target, pinnedDefault);
        return {
          ...base,
          routeSpecs: {
            deep: input.routes?.deep ?? base.routeSpecs.deep,
            light: input.routes?.light ?? base.routeSpecs.light,
            review: input.routes?.review ?? base.routeSpecs.review,
          },
        };
      }),
    };

    const content = document.createElement("div");
    document.body.append(content);
    const scope = new RendererSettingsPageScope();
    const dispose = mountDelegationRoutingControls(
      {
        content,
        signal: scope.signal,
        runLatest: (op, handlers) => scope.runLatest(op, handlers),
      },
      rendererSettingsMessages("en"),
      () => client,
    );
    disposers.push(dispose, () => scope.dispose());
    await flushMicrotasks();

    const defaultSelect = content.querySelector(
      'select[data-control="default-profile"]',
    ) as HTMLSelectElement;
    const editSelect = content.querySelector(
      'select[data-control="edit-profile"]',
    ) as HTMLSelectElement;
    const deepInput = content.querySelector('input[data-tier="deep"]') as HTMLInputElement;
    const lightInput = content.querySelector('input[data-tier="light"]') as HTMLInputElement;
    const reviewInput = content.querySelector('input[data-tier="review"]') as HTMLInputElement;
    const saveButton = content.querySelector("button.settings-command-button") as HTMLButtonElement;

    // Initial state reflects previously pinned top-level profile `thread16`.
    expect(defaultSelect.value).toBe("thread16");
    expect(editSelect.value).toBe("thread16");
    expect(deepInput.value).toBe("codex");
    expect(lightInput.value).toBe("deepseek-harness");
    expect(reviewInput.value).toBe("claude-code");

    // Reject invalid route syntax client-side before sending RPC.
    deepInput.value = "NOT VALID SPEC!!";
    saveButton.click();
    await flushMicrotasks();
    expect(deepInput.getAttribute("aria-invalid")).toBe("true");
    expect(savedPayloads).toHaveLength(0);

    // Recover from a pinned default back to automatic (by planner) without rewriting routes.
    deepInput.value = "codex";
    defaultSelect.value = "";
    defaultSelect.dispatchEvent(new Event("change"));
    saveButton.click();
    await flushMicrotasks();
    expect(savedPayloads).toEqual([{ user: true, editProfile: "thread16", defaultProfile: null }]);
    expect(defaultSelect.value).toBe("");
    expect(editSelect.value).toBe("thread16");

    // Switch editing profile to codex-planner and change only `deep`.
    editSelect.value = "codex-planner";
    editSelect.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(deepInput.value).toBe("claude-code");
    expect(reviewInput.value).toBe("codex");

    deepInput.value = "claude-code:opus@high";
    saveButton.click();
    await flushMicrotasks();

    // Only the changed route and editProfile are sent; defaultProfile stays omitted (auto).
    expect(savedPayloads.at(-1)).toEqual({
      user: true,
      editProfile: "codex-planner",
      routes: {
        deep: "claude-code:opus@high",
      },
    });
    expect(defaultSelect.value).toBe("");
    const status = content.querySelector('[role="status"]') as HTMLElement;
    expect(status.textContent).toBe("Saved");

    // Changing default profile then switching editing profile preserves the unsaved default choice.
    defaultSelect.value = "codex-planner";
    defaultSelect.dispatchEvent(new Event("change"));
    editSelect.value = "thread16";
    editSelect.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(defaultSelect.value).toBe("codex-planner");
    expect(editSelect.value).toBe("thread16");

    saveButton.click();
    await flushMicrotasks();
    expect(savedPayloads.at(-1)).toEqual({
      user: true,
      editProfile: "thread16",
      defaultProfile: "codex-planner",
    });
    // Editor stays on thread16 instead of jumping to codex-planner.
    expect(editSelect.value).toBe("thread16");
    expect(defaultSelect.value).toBe("codex-planner");

    // A failed edit-profile switch restores the dropdown back to the currently loaded profile
    // so subsequent saves target the loaded profile instead of the failed selection.
    const originalGet = client.getDelegationRouting;
    client.getDelegationRouting = async () => {
      throw new Error("network blip");
    };
    editSelect.value = "codex-planner";
    editSelect.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(editSelect.value).toBe("thread16");
    if (originalGet) client.getDelegationRouting = originalGet;
  });

  it("disables inputs and reports unavailable when Host client lacks routing RPCs", async () => {
    const content = document.createElement("div");
    document.body.append(content);
    const scope = new RendererSettingsPageScope();
    const dispose = mountDelegationRoutingControls(
      {
        content,
        signal: scope.signal,
        runLatest: (op, handlers) => scope.runLatest(op, handlers),
      },
      rendererSettingsMessages("zh-CN"),
      () => null,
    );
    disposers.push(dispose, () => scope.dispose());
    await flushMicrotasks();

    const select = content.querySelector("select") as HTMLSelectElement;
    const status = content.querySelector('[role="status"]') as HTMLElement;
    expect(select.disabled).toBe(true);
    expect(status.textContent).toBe("当前 Host 不支持");
  });
});
