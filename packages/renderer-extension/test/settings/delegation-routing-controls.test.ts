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

function makeSnapshot(profile: string): DelegationRoutingSnapshot {
  if (profile === "codex-planner") {
    return {
      profile: "codex-planner",
      profileReason: "explicit",
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

  it("loads routing snapshot, validates specs, switches profile, and saves user config", async () => {
    const savedPayloads: DelegationRoutingSetParams[] = [];
    const client: DelegationRoutingClient = {
      getDelegationRouting: vi.fn(async (input?: DelegationRoutingGetParams) =>
        makeSnapshot(input?.profile ?? "thread16"),
      ),
      setDelegationRouting: vi.fn(async (input: DelegationRoutingSetParams) => {
        savedPayloads.push(input);
        const base = makeSnapshot(input.profile ?? "thread16");
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

    const select = content.querySelector("select") as HTMLSelectElement;
    const deepInput = content.querySelector('input[data-tier="deep"]') as HTMLInputElement;
    const lightInput = content.querySelector('input[data-tier="light"]') as HTMLInputElement;
    const reviewInput = content.querySelector('input[data-tier="review"]') as HTMLInputElement;
    const saveButton = content.querySelector("button.settings-command-button") as HTMLButtonElement;

    expect(select.value).toBe("thread16");
    expect(deepInput.value).toBe("codex");
    expect(lightInput.value).toBe("deepseek-harness");
    expect(reviewInput.value).toBe("claude-code");

    // Reject invalid route syntax client-side before sending RPC.
    deepInput.value = "NOT VALID SPEC!!";
    saveButton.click();
    await flushMicrotasks();
    expect(deepInput.getAttribute("aria-invalid")).toBe("true");
    expect(savedPayloads).toHaveLength(0);

    // Switch profile and verify routes reload.
    select.value = "codex-planner";
    select.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(deepInput.value).toBe("claude-code");
    expect(reviewInput.value).toBe("codex");

    // Save customized deep route with model & thinking.
    deepInput.value = "claude-code:opus@high";
    saveButton.click();
    await flushMicrotasks();

    expect(savedPayloads).toEqual([
      {
        user: true,
        profile: "codex-planner",
        routes: {
          deep: "claude-code:opus@high",
          light: "deepseek-harness",
          review: "codex",
        },
      },
    ]);
    const status = content.querySelector('[role="status"]') as HTMLElement;
    expect(status.textContent).toBe("Saved");
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
