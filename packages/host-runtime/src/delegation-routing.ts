import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_LIGHT_MAX_CHANGED_FILES,
  DEFAULT_LIGHT_MAX_SCOPE_ENTRIES,
  DELEGATION_TIERS,
  delegationRoutingSnapshotSchema,
  type DelegationRoutingGetParams,
  type DelegationRoutingSetParams,
  type DelegationRoutingSnapshot,
  type DelegationTier,
} from "@codexhost/shared-contracts";
import { DelegationControlError } from "./delegation-types.js";
import { codexhostDataDirectory } from "./external-clients.js";

export const DELEGATION_PROFILE_ENV = "CODEXHOST_DELEGATION_PROFILE";

const HARNESS_ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MODEL_NAME_RULE = /^[A-Za-z0-9._:/@+[\]-]{1,160}$/u;
const TOP_KEYS = new Set(["profile", "profiles", "plannerProfiles", "checks", "light"]);
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_MINUTES = 24 * 60;

export interface DelegationTierRoute {
  harnessId: string;
  model?: string;
  thinkingOptionId?: string;
}

export interface DelegationRoutingLayerData {
  profile?: string;
  profiles?: Record<string, Partial<Record<DelegationTier, string | DelegationTierRoute>>>;
  plannerProfiles?: Record<string, string>;
  checks?: { timeoutMinutes?: number; shell?: string };
  light?: { maxScopeEntries?: number; maxChangedFiles?: number };
}

export interface DelegationRoutingConfig {
  planner: string;
  profile: string;
  profileReason: string;
  /** Top-level `profile` configured in routing files, or `null` when automatic planner selection applies. */
  configuredDefaultProfile: string | null;
  routes: Readonly<Record<DelegationTier, Readonly<DelegationTierRoute>>>;
  profiles: Readonly<
    Record<string, Readonly<Record<DelegationTier, Readonly<DelegationTierRoute>>>>
  >;
  plannerProfiles: Readonly<Record<string, string>>;
  sources: readonly string[];
  checks: Readonly<{ timeoutMinutes: number; shell?: string }>;
  light: Readonly<{ maxScopeEntries: number; maxChangedFiles: number }>;
}

export const DEFAULT_DELEGATION_ROUTING = Object.freeze({
  profile: "thread16",
  profiles: {
    // Default split inspired by agenthub-relay / linux.do topic 3028918:
    // Claude Code plans -> complex work to Codex, light mechanical work to DeepSeek Harness, review to Claude Code.
    thread16: {
      deep: { harnessId: "codex" },
      light: { harnessId: "deepseek-harness" },
      review: { harnessId: "claude-code" },
    },
    // When Codex plans -> complex work to Claude Code, light work to DeepSeek Harness, review to Codex.
    "codex-planner": {
      deep: { harnessId: "claude-code" },
      light: { harnessId: "deepseek-harness" },
      review: { harnessId: "codex" },
    },
  },
  plannerProfiles: {
    "claude-code": "thread16",
    codex: "codex-planner",
  },
  checks: { timeoutMinutes: 10 },
  light: {
    maxScopeEntries: DEFAULT_LIGHT_MAX_SCOPE_ENTRIES,
    maxChangedFiles: DEFAULT_LIGHT_MAX_CHANGED_FILES,
  },
});

const SETTABLE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  parse: (value: unknown) => unknown;
}> = [
  { pattern: /^profile$/u, parse: (value) => String(value ?? "").trim() },
  {
    pattern: /^plannerProfiles\.([a-z0-9-]+)$/u,
    parse: (value) => String(value ?? "").trim(),
  },
  {
    pattern: /^profiles\.([A-Za-z0-9_-]+)\.(deep|light|review)$/u,
    parse: (value) => parseDelegationRouteSpec(String(value ?? "")),
  },
  { pattern: /^checks\.timeoutMinutes$/u, parse: (value) => Number(value) },
  { pattern: /^checks\.shell$/u, parse: (value) => String(value ?? "").trim() },
  { pattern: /^light\.(maxScopeEntries|maxChangedFiles)$/u, parse: (value) => Number(value) },
];

export const SETTABLE_ROUTING_KEYS = Object.freeze([
  "profile",
  "plannerProfiles.<harnessId>",
  "profiles.<name>.<deep|light|review>",
  "checks.timeoutMinutes",
  "checks.shell",
  "light.maxScopeEntries",
  "light.maxChangedFiles",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): DelegationControlError {
  return new DelegationControlError("INVALID_ARGUMENT", message);
}

/** Parses `harnessId[:model][@thinking]`, e.g. `claude-code:opus@high` or `deepseek-harness`. */
export function parseDelegationRouteSpec(text: string): DelegationTierRoute {
  const trimmed = String(text ?? "").trim();
  const match = /^([a-z0-9][a-z0-9-]{0,63})(?::([^@]+))?(?:@(.+))?$/u.exec(trimmed);
  if (!match?.[1]) {
    throw invalid(`"${text}" must be formatted as harnessId[:model][@thinking]`);
  }
  const harnessId = match[1];
  const model = match[2]?.trim();
  const thinkingOptionId = match[3]?.trim();
  if (model !== undefined && !MODEL_NAME_RULE.test(model)) {
    throw invalid(`Model "${model}" contains invalid characters`);
  }
  if (thinkingOptionId !== undefined && !MODEL_NAME_RULE.test(thinkingOptionId)) {
    throw invalid(`Thinking option "${thinkingOptionId}" contains invalid characters`);
  }
  return {
    harnessId,
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}

export function formatDelegationRouteSpec(route: DelegationTierRoute): string {
  return `${route.harnessId}${route.model ? `:${route.model}` : ""}${route.thinkingOptionId ? `@${route.thinkingOptionId}` : ""}`;
}

export function userDelegationRoutingPath(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(codexhostDataDirectory(environment), "delegation-routing.json");
}

export function projectDelegationRoutingPath(repoRoot: string): string {
  return path.join(repoRoot, ".codexhost", "delegation-routing.json");
}

function readLayerFile(filePath: string): DelegationRoutingLayerData | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw invalid(`Cannot read routing config ${filePath}: ${(error as Error).message}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) throw new Error("top-level JSON value must be an object");
    return parsed as DelegationRoutingLayerData;
  } catch (error) {
    throw invalid(
      `${filePath} is not valid routing JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizeRouteValue(value: unknown, where: string): Readonly<DelegationTierRoute> {
  if (typeof value === "string") {
    return Object.freeze(parseDelegationRouteSpec(value));
  }
  if (!isObject(value)) {
    throw invalid(`${where} must be a harnessId[:model][@thinking] string or route object`);
  }
  for (const key of Object.keys(value)) {
    if (!["harnessId", "model", "thinkingOptionId"].includes(key)) {
      throw invalid(`${where}.${key} is not a supported route field`);
    }
  }
  if (typeof value.harnessId !== "string" || !HARNESS_ID_RULE.test(value.harnessId)) {
    throw invalid(`${where}.harnessId must be a valid Harness ID`);
  }
  if (
    value.model !== undefined &&
    (typeof value.model !== "string" || !MODEL_NAME_RULE.test(value.model))
  ) {
    throw invalid(`${where}.model is invalid`);
  }
  if (
    value.thinkingOptionId !== undefined &&
    (typeof value.thinkingOptionId !== "string" || !MODEL_NAME_RULE.test(value.thinkingOptionId))
  ) {
    throw invalid(`${where}.thinkingOptionId is invalid`);
  }
  return Object.freeze({
    harnessId: value.harnessId,
    ...(value.model ? { model: value.model } : {}),
    ...(value.thinkingOptionId ? { thinkingOptionId: value.thinkingOptionId } : {}),
  });
}

function checkMinutes(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_MINUTES) {
    throw invalid(`${where} must be a number of minutes between 0 and ${MAX_MINUTES}`);
  }
  return value;
}

/** Builds effective tiered delegation routing from layered files (lowest precedence first). */
export function buildDelegationRoutingConfig(
  input: {
    layers?: readonly {
      file: string;
      data: DelegationRoutingLayerData;
      scope?: "user" | "project";
    }[];
    environment?: NodeJS.ProcessEnv;
    plannerHarnessId?: string;
    explicitProfile?: string;
  } = {},
): DelegationRoutingConfig {
  const layers = input.layers ?? [];
  const environment = input.environment ?? {};
  const rawProfiles: Record<string, Record<string, unknown>> = structuredClone(
    DEFAULT_DELEGATION_ROUTING.profiles,
  );
  const filePlannerProfiles: Record<string, string> = {};
  const checks: { timeoutMinutes: number; shell?: string } = {
    ...DEFAULT_DELEGATION_ROUTING.checks,
  };
  const light = { ...DEFAULT_DELEGATION_ROUTING.light };
  let fileProfile: string | undefined;

  for (const { file, data, scope } of layers) {
    for (const key of Object.keys(data)) {
      if (!TOP_KEYS.has(key)) throw invalid(`${file}: unknown routing key "${key}"`);
    }
    if (data.profiles !== undefined) {
      if (!isObject(data.profiles)) throw invalid(`${file}: profiles must be an object`);
      for (const [name, mapping] of Object.entries(data.profiles)) {
        if (RESERVED_OBJECT_KEYS.has(name)) {
          throw invalid(`${file}: profile name "${name}" is reserved`);
        }
        if (!isObject(mapping)) throw invalid(`${file}: profile "${name}" must be an object`);
        const existing = Object.hasOwn(rawProfiles, name) ? rawProfiles[name] : undefined;
        rawProfiles[name] = { ...(existing ?? {}), ...mapping };
      }
    }
    if (data.plannerProfiles !== undefined) {
      if (!isObject(data.plannerProfiles)) {
        throw invalid(`${file}: plannerProfiles must be an object`);
      }
      for (const [plannerId, profileName] of Object.entries(data.plannerProfiles)) {
        if (RESERVED_OBJECT_KEYS.has(plannerId) || !HARNESS_ID_RULE.test(plannerId)) {
          throw invalid(`${file}: plannerProfiles.${plannerId} is not a valid Harness ID`);
        }
        if (typeof profileName !== "string" || !profileName.trim()) {
          throw invalid(`${file}: plannerProfiles.${plannerId} must be a profile name`);
        }
        filePlannerProfiles[plannerId] = profileName.trim();
      }
    }
    if (data.checks !== undefined) {
      if (!isObject(data.checks)) throw invalid(`${file}: checks must be an object`);
      for (const [key, value] of Object.entries(data.checks)) {
        if (key === "timeoutMinutes") {
          checks.timeoutMinutes = checkMinutes(value, `${file}: checks.timeoutMinutes`);
        } else if (key === "shell") {
          if (scope !== "user") {
            throw invalid(
              `${file}: checks.shell can only be configured in the user routing config, not in project config. Remove checks.shell from this file or run "codexhost delegate routing unset checks.shell" in this repository.`,
            );
          }
          if (typeof value !== "string" || !value.trim()) {
            throw invalid(`${file}: checks.shell must be a non-empty shell path or name`);
          }
          checks.shell = value.trim();
        } else {
          throw invalid(`${file}: unknown checks setting "${key}"`);
        }
      }
    }
    if (data.light !== undefined) {
      if (!isObject(data.light)) throw invalid(`${file}: light must be an object`);
      for (const [key, value] of Object.entries(data.light)) {
        if (key !== "maxScopeEntries" && key !== "maxChangedFiles") {
          throw invalid(`${file}: unknown light setting "${key}"`);
        }
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) {
          throw invalid(`${file}: light.${key} must be an integer between 1 and 1000`);
        }
        light[key] = value;
      }
    }
    if (data.profile !== undefined) {
      if (typeof data.profile !== "string" || !data.profile.trim()) {
        throw invalid(`${file}: profile must be a non-empty string`);
      }
      fileProfile = data.profile.trim();
    }
  }

  const normalizedProfiles: Record<
    string,
    Record<DelegationTier, Readonly<DelegationTierRoute>>
  > = {};
  for (const [name, mapping] of Object.entries(rawProfiles)) {
    const routes = {} as Record<DelegationTier, Readonly<DelegationTierRoute>>;
    for (const [tier, value] of Object.entries(mapping)) {
      if (!(DELEGATION_TIERS as readonly string[]).includes(tier)) {
        throw invalid(`Profile "${name}" contains unknown tier "${tier}"`);
      }
      routes[tier as DelegationTier] = normalizeRouteValue(value, `profiles.${name}.${tier}`);
    }
    for (const tier of DELEGATION_TIERS) {
      if (!routes[tier]) {
        throw invalid(`Profile "${name}" is missing a route for the "${tier}" tier`);
      }
    }
    normalizedProfiles[name] = Object.freeze(routes);
  }

  for (const [plannerId, profileName] of Object.entries(filePlannerProfiles)) {
    if (!Object.hasOwn(normalizedProfiles, profileName)) {
      throw invalid(`plannerProfiles.${plannerId} references undefined profile "${profileName}"`);
    }
  }

  const planner = input.plannerHarnessId?.trim() || "unknown";
  const envProfile = environment[DELEGATION_PROFILE_ENV]?.trim();
  const builtInPlannerProfiles: Record<string, string> = {
    ...DEFAULT_DELEGATION_ROUTING.plannerProfiles,
  };
  let profile: string;
  let profileReason: string;
  if (input.explicitProfile?.trim()) {
    profile = input.explicitProfile.trim();
    profileReason = "explicit --profile argument";
  } else if (envProfile) {
    profile = envProfile;
    profileReason = DELEGATION_PROFILE_ENV;
  } else if (Object.hasOwn(filePlannerProfiles, planner) && filePlannerProfiles[planner]) {
    profile = filePlannerProfiles[planner];
    profileReason = `plannerProfiles.${planner} in routing config`;
  } else if (fileProfile !== undefined) {
    profile = fileProfile;
    profileReason = "profile in routing config";
  } else if (Object.hasOwn(builtInPlannerProfiles, planner) && builtInPlannerProfiles[planner]) {
    profile = builtInPlannerProfiles[planner];
    profileReason = `built-in default for a ${planner} planner`;
  } else {
    profile = DEFAULT_DELEGATION_ROUTING.profile;
    profileReason = "built-in default";
  }

  const routes = Object.hasOwn(normalizedProfiles, profile)
    ? normalizedProfiles[profile]
    : undefined;
  if (!routes) {
    throw invalid(
      `Routing profile "${profile}" is not defined (known: ${Object.keys(normalizedProfiles).join(", ")})`,
    );
  }

  return Object.freeze({
    planner,
    profile,
    profileReason,
    configuredDefaultProfile: fileProfile ?? null,
    routes,
    profiles: Object.freeze(normalizedProfiles),
    plannerProfiles: Object.freeze({ ...builtInPlannerProfiles, ...filePlannerProfiles }),
    sources: Object.freeze(layers.map((layer) => layer.file)),
    checks: Object.freeze(checks),
    light: Object.freeze(light),
  });
}

export function loadDelegationRoutingLayers(
  input: {
    repoRoot?: string;
    environment?: NodeJS.ProcessEnv;
  } = {},
): Array<{ file: string; data: DelegationRoutingLayerData; scope: "user" | "project" }> {
  const layers: Array<{
    file: string;
    data: DelegationRoutingLayerData;
    scope: "user" | "project";
  }> = [];
  const userFile = userDelegationRoutingPath(input.environment);
  const projectFile = input.repoRoot ? projectDelegationRoutingPath(input.repoRoot) : null;
  const candidates: Array<{ file: string | null; scope: "user" | "project" }> = [
    { file: userFile, scope: "user" },
    { file: projectFile, scope: "project" },
  ];
  for (const { file, scope } of candidates) {
    if (!file || layers.some((existing) => sameFilePath(existing.file, file))) continue;
    const data = readLayerFile(file);
    if (data) layers.push({ file, data, scope });
  }
  return layers;
}

export function loadDelegationRoutingConfig(
  input: {
    repoRoot?: string;
    environment?: NodeJS.ProcessEnv;
    plannerHarnessId?: string;
    explicitProfile?: string;
  } = {},
): DelegationRoutingConfig {
  return buildDelegationRoutingConfig({
    layers: loadDelegationRoutingLayers(input),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.plannerHarnessId ? { plannerHarnessId: input.plannerHarnessId } : {}),
    ...(input.explicitProfile ? { explicitProfile: input.explicitProfile } : {}),
  });
}

const RETRY_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sameFilePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inferRoutingFileScope(
  file: string,
  explicitScope: "user" | "project" | undefined,
  layersBelow?: readonly { file: string; scope?: "user" | "project" }[],
  environment?: NodeJS.ProcessEnv,
): "user" | "project" | undefined {
  if (explicitScope) return explicitScope;
  if (layersBelow?.some((layer) => layer.scope === "user")) return "project";
  if (environment !== undefined) {
    return sameFilePath(file, userDelegationRoutingPath(environment)) ? "user" : "project";
  }
  return undefined;
}

/** Retries atomic rename briefly on Windows where antivirus/readers can transiently lock target files. */
export function renameSyncWithRetry(source: string, target: string): void {
  const retryable = new Set(["EPERM", "EACCES", "EBUSY"]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !retryable.has((error as NodeJS.ErrnoException).code ?? "") ||
        attempt === 19
      ) {
        throw error;
      }
      Atomics.wait(RETRY_WAIT_ARRAY, 0, 0, 25);
    }
  }
}

export function writeDelegationRoutingSetting(input: {
  file: string;
  key: string;
  value?: unknown;
  unset?: boolean;
  scope?: "user" | "project";
  environment?: NodeJS.ProcessEnv;
  layersBelow?: readonly {
    file: string;
    data: DelegationRoutingLayerData;
    scope?: "user" | "project";
  }[];
}): { file: string; key: string; value?: unknown; removed: boolean } {
  const rule = SETTABLE_PATTERNS.find((entry) => entry.pattern.test(input.key));
  if (!rule) {
    throw invalid(
      `"${input.key}" cannot be set here (settable: ${SETTABLE_ROUTING_KEYS.join(", ")})`,
    );
  }
  const inferredScope = inferRoutingFileScope(
    input.file,
    input.scope,
    input.layersBelow,
    input.environment,
  );
  if (input.key === "checks.shell" && !input.unset && inferredScope !== "user") {
    throw invalid(
      "checks.shell can only be configured in the user routing config, not in project config",
    );
  }
  const targetScope: "user" | "project" = inferredScope ?? "project";
  const data = (readLayerFile(input.file) ?? {}) as Record<string, unknown>;
  const parts = input.key.split(".");
  if (parts.some((part) => RESERVED_OBJECT_KEYS.has(part))) {
    throw invalid(`"${input.key}" contains a reserved property name`);
  }
  let cursor = data;
  let missing = false;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(cursor, part) || !isObject(cursor[part])) {
      if (input.unset) {
        missing = true;
        break;
      }
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1] as string;
  let removed = false;
  let parsedValue: unknown;
  if (input.unset) {
    if (!missing && Object.hasOwn(cursor, leaf)) {
      Reflect.deleteProperty(cursor, leaf);
      removed = true;
    }
  } else {
    parsedValue = rule.parse(input.value);
    cursor[leaf] = parsedValue;
  }

  // Validate full merged configuration before touching disk.
  buildDelegationRoutingConfig({
    layers: [
      ...(input.layersBelow ?? []),
      { file: input.file, data: data as DelegationRoutingLayerData, scope: targetScope },
    ],
  });

  fs.mkdirSync(path.dirname(input.file), { recursive: true, mode: 0o700 });
  const temporary = `${input.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSyncWithRetry(temporary, input.file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { file: input.file, key: input.key, value: parsedValue, removed };
}

export function readDelegationRoutingSnapshot(
  params: DelegationRoutingGetParams = {},
  environment: NodeJS.ProcessEnv = process.env,
): DelegationRoutingSnapshot {
  const config = loadDelegationRoutingConfig({
    environment,
    ...(params.repoRoot ? { repoRoot: params.repoRoot } : {}),
    ...(params.planner ? { plannerHarnessId: params.planner } : {}),
    ...(params.profile ? { explicitProfile: params.profile } : {}),
  });
  const userConfigPath = userDelegationRoutingPath(environment);
  const projectConfigPath = params.repoRoot
    ? projectDelegationRoutingPath(params.repoRoot)
    : undefined;
  return delegationRoutingSnapshotSchema.parse({
    profile: config.profile,
    profileReason: config.profileReason,
    configuredDefaultProfile: config.configuredDefaultProfile,
    availableProfiles: Object.keys(config.profiles),
    routes: {
      deep: { ...config.routes.deep },
      light: { ...config.routes.light },
      review: { ...config.routes.review },
    },
    routeSpecs: {
      deep: formatDelegationRouteSpec(config.routes.deep),
      light: formatDelegationRouteSpec(config.routes.light),
      review: formatDelegationRouteSpec(config.routes.review),
    },
    sources: [...config.sources],
    userConfigPath,
    ...(projectConfigPath ? { projectConfigPath } : {}),
  });
}

/** Atomically applies default profile and/or tier route updates from Desktop/Web settings and returns the confirmed snapshot. */
export function applyDelegationRoutingPatch(
  params: DelegationRoutingSetParams,
  environment: NodeJS.ProcessEnv = process.env,
): DelegationRoutingSnapshot {
  const useUser = params.user !== false || !params.repoRoot;
  const userFile = userDelegationRoutingPath(environment);
  const targetFile = useUser ? userFile : projectDelegationRoutingPath(params.repoRoot as string);
  const targetScope: "user" | "project" = sameFilePath(targetFile, userFile)
    ? "user"
    : useUser
      ? "user"
      : "project";
  const layers = loadDelegationRoutingLayers({
    environment,
    ...(params.repoRoot ? { repoRoot: params.repoRoot } : {}),
  });
  const layersBelow =
    targetScope === "user"
      ? []
      : layers.filter((layer) => layer.scope === "user" && !sameFilePath(layer.file, targetFile));
  const current = loadDelegationRoutingConfig({
    environment,
    ...(params.repoRoot ? { repoRoot: params.repoRoot } : {}),
  });

  const data = (readLayerFile(targetFile) ?? {}) as Record<string, unknown>;
  const requestedEditProfile = params.editProfile?.trim() || params.profile?.trim();
  const targetEditProfile = requestedEditProfile || current.profile;
  if (params.defaultProfile === null) {
    Reflect.deleteProperty(data, "profile");
  } else if (typeof params.defaultProfile === "string") {
    data.profile = params.defaultProfile.trim();
  }
  if (
    params.routes !== undefined &&
    DELEGATION_TIERS.some((tier) => params.routes?.[tier] !== undefined)
  ) {
    const profiles = isObject(data.profiles) ? { ...data.profiles } : {};
    const existingProfile = isObject(profiles[targetEditProfile])
      ? { ...(profiles[targetEditProfile] as Record<string, unknown>) }
      : {};
    for (const tier of DELEGATION_TIERS) {
      const spec = params.routes[tier];
      if (spec !== undefined) {
        existingProfile[tier] = parseDelegationRouteSpec(spec);
      }
    }
    profiles[targetEditProfile] = existingProfile;
    data.profiles = profiles;
  }

  const validated = buildDelegationRoutingConfig({
    layers: [
      ...layersBelow,
      { file: targetFile, data: data as DelegationRoutingLayerData, scope: targetScope },
    ],
  });
  if (typeof params.defaultProfile === "string") {
    const requestedDefault = params.defaultProfile.trim();
    if (!Object.hasOwn(validated.profiles, requestedDefault)) {
      throw invalid(
        `Routing profile "${requestedDefault}" is not defined (known: ${Object.keys(validated.profiles).join(", ")})`,
      );
    }
  }
  if (requestedEditProfile && !Object.hasOwn(validated.profiles, requestedEditProfile)) {
    throw invalid(
      `Routing profile "${requestedEditProfile}" is not defined (known: ${Object.keys(validated.profiles).join(", ")})`,
    );
  }

  fs.mkdirSync(path.dirname(targetFile), { recursive: true, mode: 0o700 });
  const temporary = `${targetFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSyncWithRetry(temporary, targetFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }

  return readDelegationRoutingSnapshot(
    {
      ...(params.repoRoot ? { repoRoot: params.repoRoot } : {}),
      ...(requestedEditProfile ? { profile: requestedEditProfile } : {}),
    },
    environment,
  );
}
