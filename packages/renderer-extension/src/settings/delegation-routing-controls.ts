import {
  DELEGATION_TIERS,
  type DelegationRoutingGetParams,
  type DelegationRoutingSetParams,
  type DelegationRoutingSnapshot,
  type DelegationTier,
} from "@codexhost/shared-contracts";
import { RendererMethodUnavailableError } from "../renderer-request-sender.js";
import type { RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createPreferenceGroup, createPreferenceItem, preferenceId } from "./preference-ui.js";

export interface DelegationRoutingClient {
  getDelegationRouting?(input?: DelegationRoutingGetParams): Promise<DelegationRoutingSnapshot>;
  setDelegationRouting?(input: DelegationRoutingSetParams): Promise<DelegationRoutingSnapshot>;
}

const ROUTE_SPEC_RULE =
  /^[a-z0-9][a-z0-9-]{0,63}(?::[A-Za-z0-9._:/+[\]-]{1,160})?(?:@[A-Za-z0-9._:/@+[\]-]{1,160})?$/u;

type RoutingStatus = "loading" | "applied" | "saving" | "saved" | "unavailable" | "failed";

function validRouteSpec(value: string): boolean {
  return ROUTE_SPEC_RULE.test(value.trim());
}

export function mountDelegationRoutingControls(
  context: RendererSettingsPageMountContext,
  messages: RendererSettingsMessages,
  getClient: () => DelegationRoutingClient | null,
): () => void {
  const { content } = context;
  const document = content.ownerDocument;
  const owner = document.defaultView;
  if (!owner) return () => undefined;

  const { group, header, card } = createPreferenceGroup(
    document,
    messages.delegationRoutingSection,
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

  const defaultProfileId = preferenceId("delegation-routing-default-profile");
  const defaultProfileRow = createPreferenceItem(document, {
    title: messages.delegationRoutingDefaultProfileTitle,
    description: messages.delegationRoutingDefaultProfileDescription,
    controlId: defaultProfileId,
    help: {
      label: messages.delegationRoutingHelpLabel,
      lines: messages.delegationRoutingHelp,
    },
  });
  const defaultProfileSelect = document.createElement("select");
  defaultProfileSelect.id = defaultProfileId;
  defaultProfileSelect.dataset.control = "default-profile";
  defaultProfileSelect.setAttribute("aria-describedby", defaultProfileRow.description.id);
  defaultProfileSelect.className =
    "h-8 min-w-40 shrink-0 rounded-md border border-settings-border bg-settings-surface px-2.5 text-[13px] leading-5 text-settings-text outline-none transition-colors focus:border-settings-focus";
  defaultProfileRow.item.append(defaultProfileSelect);
  card.append(defaultProfileRow.item);

  const profileId = preferenceId("delegation-routing-profile");
  const profileRow = createPreferenceItem(document, {
    title: messages.delegationRoutingProfileTitle,
    description: messages.delegationRoutingProfileDescription,
    controlId: profileId,
  });
  const profileSelect = document.createElement("select");
  profileSelect.id = profileId;
  profileSelect.dataset.control = "edit-profile";
  profileSelect.setAttribute("aria-describedby", profileRow.description.id);
  profileSelect.className =
    "h-8 min-w-40 shrink-0 rounded-md border border-settings-border bg-settings-surface px-2.5 text-[13px] leading-5 text-settings-text outline-none transition-colors focus:border-settings-focus";
  profileRow.item.append(profileSelect);
  card.append(profileRow.item);

  const tierInputs: Record<
    DelegationTier,
    { input: HTMLInputElement; description: HTMLElement; defaultDescription: string }
  > = {} as Record<
    DelegationTier,
    { input: HTMLInputElement; description: HTMLElement; defaultDescription: string }
  >;

  const tierLabels: Record<DelegationTier, { title: string; description: string }> = {
    deep: {
      title: messages.delegationRoutingDeepTitle,
      description: messages.delegationRoutingDeepDescription,
    },
    light: {
      title: messages.delegationRoutingLightTitle,
      description: messages.delegationRoutingLightDescription,
    },
    review: {
      title: messages.delegationRoutingReviewTitle,
      description: messages.delegationRoutingReviewDescription,
    },
  };

  for (const tier of DELEGATION_TIERS) {
    const id = preferenceId(`delegation-routing-${tier}`);
    const row = createPreferenceItem(document, {
      title: tierLabels[tier].title,
      description: tierLabels[tier].description,
      controlId: id,
    });
    const input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.dataset.tier = tier;
    input.placeholder = "harness[:model][@thinking]";
    input.setAttribute("aria-describedby", row.description.id);
    input.className =
      "h-8 w-56 shrink-0 rounded-md border border-settings-border bg-settings-surface px-2.5 font-mono text-xs leading-5 text-settings-text outline-none transition-colors focus:border-settings-focus data-[invalid=true]:border-settings-danger";
    row.item.append(input);
    card.append(row.item);
    tierInputs[tier] = {
      input,
      description: row.description,
      defaultDescription: tierLabels[tier].description,
    };
  }

  const footer = document.createElement("div");
  footer.className =
    "flex flex-wrap items-center justify-between gap-3 border-t border-settings-divider px-4 py-3";
  const pathNote = document.createElement("span");
  pathNote.className = "truncate font-mono text-xs text-settings-muted";
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "settings-command-button";
  saveButton.textContent = messages.delegationRoutingSave;
  footer.append(pathNote, saveButton);
  card.append(footer);
  content.append(group);

  let disposed = false;
  let busy = false;
  let available = false;
  let loadedDefaultProfile: string | null = null;
  let loadedEditProfile = "";
  let defaultDirty = false;
  let loadedRouteSpecs: Record<DelegationTier, string> = { deep: "", light: "", review: "" };

  const setDisabled = (disabled: boolean): void => {
    defaultProfileSelect.disabled = disabled;
    profileSelect.disabled = disabled;
    saveButton.disabled = disabled;
    for (const tier of DELEGATION_TIERS) tierInputs[tier].input.disabled = disabled;
  };

  const showStatus = (state: RoutingStatus, detail?: string): void => {
    status.dataset.state = state;
    status.hidden = state === "applied";
    if (state === "applied") {
      statusText.textContent = "";
    } else if (state === "loading" || state === "saving") {
      statusText.textContent = messages.idleReleasePending;
    } else if (state === "saved") {
      statusText.textContent = messages.delegationRoutingSaved;
    } else if (state === "unavailable") {
      statusText.textContent = messages.idleReleaseUnavailable;
    } else {
      statusText.textContent = detail ?? messages.idleReleaseFailed;
    }
  };

  const setTierInvalid = (tier: DelegationTier, invalid: boolean): void => {
    const entry = tierInputs[tier];
    entry.input.dataset.invalid = String(invalid);
    entry.description.dataset.invalid = String(invalid);
    entry.description.textContent = invalid
      ? messages.delegationRoutingInvalidSpec
      : entry.defaultDescription;
    entry.input.setAttribute("aria-invalid", String(invalid));
    entry.input.setCustomValidity(invalid ? messages.delegationRoutingInvalidSpec : "");
  };

  const applySnapshot = (
    snapshot: DelegationRoutingSnapshot,
    options: { preserveUnsavedDefault?: boolean } = {},
  ): void => {
    const unsavedDefaultValue =
      options.preserveUnsavedDefault && defaultDirty ? defaultProfileSelect.value : undefined;
    available = true;
    loadedDefaultProfile = snapshot.configuredDefaultProfile ?? null;
    defaultProfileSelect.replaceChildren();
    const autoOption = document.createElement("option");
    autoOption.value = "";
    autoOption.textContent = messages.delegationRoutingDefaultProfileAuto;
    defaultProfileSelect.append(autoOption);
    for (const name of snapshot.availableProfiles) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      defaultProfileSelect.append(option);
    }
    if (
      unsavedDefaultValue !== undefined &&
      (unsavedDefaultValue === "" || snapshot.availableProfiles.includes(unsavedDefaultValue))
    ) {
      defaultProfileSelect.value = unsavedDefaultValue;
      defaultDirty = (unsavedDefaultValue || null) !== loadedDefaultProfile;
    } else {
      defaultProfileSelect.value = loadedDefaultProfile ?? "";
      defaultDirty = false;
    }

    profileSelect.replaceChildren();
    for (const name of snapshot.availableProfiles) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      profileSelect.append(option);
    }
    profileSelect.value = snapshot.profile;
    loadedEditProfile = snapshot.profile;
    loadedRouteSpecs = {
      deep: snapshot.routeSpecs.deep,
      light: snapshot.routeSpecs.light,
      review: snapshot.routeSpecs.review,
    };
    for (const tier of DELEGATION_TIERS) {
      tierInputs[tier].input.value = snapshot.routeSpecs[tier];
      setTierInvalid(tier, false);
    }
    pathNote.textContent = snapshot.userConfigPath;
    setDisabled(false);
  };

  const load = async (
    profile?: string,
    options: { preserveUnsavedDefault?: boolean } = {},
  ): Promise<void> => {
    const client = getClient();
    if (!client?.getDelegationRouting) {
      available = false;
      setDisabled(true);
      showStatus("unavailable");
      return;
    }
    busy = true;
    setDisabled(true);
    showStatus("loading");
    try {
      const snapshot = await client.getDelegationRouting(profile ? { profile } : {});
      if (disposed) return;
      applySnapshot(snapshot, options);
      showStatus("applied");
    } catch (error) {
      if (disposed) return;
      if (error instanceof RendererMethodUnavailableError) {
        available = false;
        setDisabled(true);
        showStatus("unavailable");
      } else {
        if (available && loadedEditProfile) profileSelect.value = loadedEditProfile;
        setDisabled(!available);
        showStatus("failed", error instanceof Error ? error.message : undefined);
      }
    } finally {
      busy = false;
    }
  };

  const save = async (): Promise<void> => {
    if (busy || !available) return;
    const client = getClient();
    if (!client?.setDelegationRouting) {
      showStatus("unavailable");
      return;
    }
    let hasInvalid = false;
    const changedRoutes: Partial<Record<DelegationTier, string>> = {};
    for (const tier of DELEGATION_TIERS) {
      const value = tierInputs[tier].input.value.trim();
      const valid = validRouteSpec(value);
      setTierInvalid(tier, !valid);
      if (!valid) hasInvalid = true;
      else if (value !== loadedRouteSpecs[tier]) changedRoutes[tier] = value;
    }
    if (hasInvalid) return;
    const desiredDefault = defaultProfileSelect.value ? defaultProfileSelect.value : null;
    const defaultChanged = desiredDefault !== loadedDefaultProfile;
    const hasRouteChanges = Object.keys(changedRoutes).length > 0;
    if (!defaultChanged && !hasRouteChanges) {
      showStatus("saved");
      return;
    }
    busy = true;
    setDisabled(true);
    showStatus("saving");
    const editProfile = loadedEditProfile || profileSelect.value;
    try {
      const snapshot = await client.setDelegationRouting({
        user: true,
        ...(editProfile ? { editProfile } : {}),
        ...(hasRouteChanges ? { routes: changedRoutes } : {}),
        ...(defaultChanged ? { defaultProfile: desiredDefault } : {}),
      });
      if (disposed) return;
      applySnapshot(snapshot);
      showStatus("saved");
    } catch (error) {
      if (disposed) return;
      setDisabled(false);
      showStatus(
        error instanceof RendererMethodUnavailableError ? "unavailable" : "failed",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      busy = false;
    }
  };

  for (const tier of DELEGATION_TIERS) {
    tierInputs[tier].input.addEventListener("input", () => {
      if (tierInputs[tier].input.getAttribute("aria-invalid") === "true") {
        setTierInvalid(tier, false);
      }
    });
  }
  defaultProfileSelect.addEventListener("change", () => {
    defaultDirty = (defaultProfileSelect.value || null) !== loadedDefaultProfile;
  });
  profileSelect.addEventListener("change", () => {
    if (!busy && profileSelect.value) {
      void load(profileSelect.value, { preserveUnsavedDefault: true });
    }
  });
  saveButton.addEventListener("click", () => {
    void save();
  });

  setDisabled(true);
  void load();
  return () => {
    disposed = true;
  };
}
