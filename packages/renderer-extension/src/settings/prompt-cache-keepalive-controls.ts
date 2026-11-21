import {
  PROMPT_CACHE_KEEPALIVE_CEILING_HOURS_MAX,
  PROMPT_CACHE_KEEPALIVE_CEILING_HOURS_MIN,
  PROMPT_CACHE_KEEPALIVE_INTERVAL_MINUTES_MAX,
  PROMPT_CACHE_KEEPALIVE_INTERVAL_MINUTES_MIN,
  promptCacheKeepAliveSettingsSchema,
  type PromptCacheKeepAliveSettings,
} from "@codexhost/shared-contracts";
import {
  PROMPT_CACHE_KEEPALIVE_CHANGE_EVENT,
  PROMPT_CACHE_KEEPALIVE_STATUS_EVENT,
  readPromptCacheKeepAlivePreference,
  writePromptCacheKeepAlivePreference,
  type PromptCacheKeepAliveSyncStatus,
} from "../renderer-prompt-cache-keepalive-preference.js";
import { rendererHarnessPreferenceStatus } from "../renderer-harness-preferences.js";
import type { RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";
import {
  createNumberField,
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSwitch,
  preferenceId,
} from "./preference-ui.js";

export function mountPromptCacheKeepAliveControls(
  context: RendererSettingsPageMountContext,
  messages: RendererSettingsMessages,
): () => void {
  const { content } = context;
  const document = content.ownerDocument;
  const owner = document.defaultView;
  if (!owner) return () => undefined;
  const { group, header, card } = createPreferenceGroup(
    document,
    messages.promptCacheKeepAliveSection,
  );

  const status = document.createElement("div");
  status.className =
    "group/status ml-auto inline-flex items-center gap-1.5 text-xs leading-[18px] text-settings-muted data-[state=failed]:text-settings-danger data-[state=unavailable]:text-settings-warning";
  const statusDot = document.createElement("span");
  statusDot.setAttribute("aria-hidden", "true");
  statusDot.className =
    "size-1.5 shrink-0 rounded-full bg-settings-subtle group-data-[state=failed]/status:bg-settings-danger group-data-[state=unavailable]/status:bg-settings-warning";
  const statusText = document.createElement("span");
  statusText.setAttribute("role", "status");
  status.append(statusDot, statusText);
  header.append(status);

  const enabledId = preferenceId("prompt-cache-keepalive-enabled");
  const toggle = createPreferenceItem(document, {
    title: messages.promptCacheKeepAliveTitle,
    description: messages.promptCacheKeepAliveDescription,
    controlId: enabledId,
    help: {
      label: messages.promptCacheKeepAliveHelpLabel,
      lines: messages.promptCacheKeepAliveHelp,
    },
  });
  const enabled = createPreferenceSwitch(document, enabledId, toggle.description.id);
  toggle.item.append(enabled);

  const intervalId = preferenceId("prompt-cache-keepalive-interval");
  const intervalRow = createPreferenceItem(document, {
    title: messages.promptCacheKeepAliveIntervalTitle,
    description: messages.promptCacheKeepAliveIntervalDescription,
    controlId: intervalId,
  });
  const { field: intervalField, control: intervalInput } = createNumberField(document, {
    id: intervalId,
    describedBy: intervalRow.description.id,
    unit: messages.idleReleaseMinutes,
    min: PROMPT_CACHE_KEEPALIVE_INTERVAL_MINUTES_MIN,
    max: PROMPT_CACHE_KEEPALIVE_INTERVAL_MINUTES_MAX,
  });
  intervalRow.item.append(intervalField);
  intervalRow.item.id = preferenceId("prompt-cache-keepalive-interval-row");

  const ceilingId = preferenceId("prompt-cache-keepalive-ceiling");
  const ceilingRow = createPreferenceItem(document, {
    title: messages.promptCacheKeepAliveCeilingTitle,
    description: messages.promptCacheKeepAliveCeilingDescription,
    controlId: ceilingId,
  });
  const { field: ceilingField, control: ceilingInput } = createNumberField(document, {
    id: ceilingId,
    describedBy: ceilingRow.description.id,
    unit: messages.promptCacheKeepAliveHours,
    min: PROMPT_CACHE_KEEPALIVE_CEILING_HOURS_MIN,
    max: PROMPT_CACHE_KEEPALIVE_CEILING_HOURS_MAX,
  });
  ceilingRow.item.append(ceilingField);
  ceilingRow.item.id = preferenceId("prompt-cache-keepalive-ceiling-row");

  enabled.setAttribute("aria-controls", `${intervalRow.item.id} ${ceilingRow.item.id}`);
  card.append(toggle.item, intervalRow.item, ceilingRow.item);
  content.append(group);

  const statusMessages: Record<Exclude<PromptCacheKeepAliveSyncStatus, "applied">, string> = {
    pending: messages.idleReleasePending,
    unavailable: messages.idleReleaseUnavailable,
    failed: messages.idleReleaseFailed,
  };
  const showStatus = (value: PromptCacheKeepAliveSyncStatus): void => {
    status.dataset.state = value;
    status.hidden = value === "applied";
    statusText.textContent = value === "applied" ? "" : statusMessages[value];
  };
  const setIntervalInvalid = (invalid: boolean): void => {
    intervalField.dataset.invalid = String(invalid);
    intervalRow.description.dataset.invalid = String(invalid);
    intervalRow.description.textContent = invalid
      ? messages.promptCacheKeepAliveIntervalInvalid
      : messages.promptCacheKeepAliveIntervalDescription;
    intervalInput.setAttribute("aria-invalid", String(invalid));
    intervalInput.setCustomValidity(invalid ? messages.promptCacheKeepAliveIntervalInvalid : "");
  };
  const setCeilingInvalid = (invalid: boolean): void => {
    ceilingField.dataset.invalid = String(invalid);
    ceilingRow.description.dataset.invalid = String(invalid);
    ceilingRow.description.textContent = invalid
      ? messages.promptCacheKeepAliveCeilingInvalid
      : messages.promptCacheKeepAliveCeilingDescription;
    ceilingInput.setAttribute("aria-invalid", String(invalid));
    ceilingInput.setCustomValidity(invalid ? messages.promptCacheKeepAliveCeilingInvalid : "");
  };

  const sync = (): void => {
    const settings = readPromptCacheKeepAlivePreference(owner);
    enabled.checked = settings.enabled;
    intervalRow.item.hidden = !settings.enabled;
    ceilingRow.item.hidden = !settings.enabled;
    if (!settings.enabled) {
      if (intervalInput.getAttribute("aria-invalid") === "true") setIntervalInvalid(false);
      if (ceilingInput.getAttribute("aria-invalid") === "true") setCeilingInvalid(false);
    }
    if (intervalInput.getAttribute("aria-invalid") !== "true") {
      intervalInput.value = String(settings.intervalMinutes);
    }
    if (ceilingInput.getAttribute("aria-invalid") !== "true") {
      ceilingInput.value = String(settings.ceilingHours);
    }
  };
  const save = (settings: PromptCacheKeepAliveSettings): void => {
    if (writePromptCacheKeepAlivePreference(owner, settings)) return;
    sync();
    showStatus("failed");
  };

  enabled.addEventListener("change", () => {
    save({ ...readPromptCacheKeepAlivePreference(owner), enabled: enabled.checked });
  });
  intervalInput.addEventListener("change", () => {
    const current = readPromptCacheKeepAlivePreference(owner);
    const parsed = promptCacheKeepAliveSettingsSchema.safeParse({
      ...current,
      intervalMinutes: intervalInput.valueAsNumber,
    });
    setIntervalInvalid(!parsed.success);
    if (parsed.success) save(parsed.data);
  });
  intervalInput.addEventListener("input", () => {
    if (intervalInput.getAttribute("aria-invalid") === "true") setIntervalInvalid(false);
  });
  ceilingInput.addEventListener("change", () => {
    const current = readPromptCacheKeepAlivePreference(owner);
    const parsed = promptCacheKeepAliveSettingsSchema.safeParse({
      ...current,
      ceilingHours: ceilingInput.valueAsNumber,
    });
    setCeilingInvalid(!parsed.success);
    if (parsed.success) save(parsed.data);
  });
  ceilingInput.addEventListener("input", () => {
    if (ceilingInput.getAttribute("aria-invalid") === "true") setCeilingInvalid(false);
  });

  const onStatus = (event: Event): void =>
    showStatus((event as CustomEvent<PromptCacheKeepAliveSyncStatus>).detail);
  owner.addEventListener(PROMPT_CACHE_KEEPALIVE_CHANGE_EVENT, sync);
  owner.addEventListener(PROMPT_CACHE_KEEPALIVE_STATUS_EVENT, onStatus);
  sync();
  showStatus(rendererHarnessPreferenceStatus());
  return () => {
    owner.removeEventListener(PROMPT_CACHE_KEEPALIVE_CHANGE_EVENT, sync);
    owner.removeEventListener(PROMPT_CACHE_KEEPALIVE_STATUS_EVENT, onStatus);
  };
}
