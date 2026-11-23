import { z } from "zod";

export const DELEGATION_TIERS = ["deep", "light", "review"] as const;
export type DelegationTier = (typeof DELEGATION_TIERS)[number];

export const DEFAULT_LIGHT_MAX_SCOPE_ENTRIES = 10;
export const DEFAULT_LIGHT_MAX_CHANGED_FILES = 10;

export const DELEGATION_ROUTING_GET_METHOD = "codexhost/delegation/routing/get";
export const DELEGATION_ROUTING_SET_METHOD = "codexhost/delegation/routing/set";

const HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const RESERVED_PROFILE_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const MODEL_NAME_PATTERN = /^[A-Za-z0-9._:/@+[\]-]{1,160}$/u;

const profileNameSchema = z
  .string()
  .regex(PROFILE_NAME_PATTERN)
  .refine((value) => !RESERVED_PROFILE_NAMES.has(value), "Reserved profile name");

export const delegationTierSchema = z.enum(DELEGATION_TIERS);

export const delegationTierRouteSchema = z.strictObject({
  harnessId: z.string().regex(HARNESS_ID_PATTERN),
  model: z.string().regex(MODEL_NAME_PATTERN).optional(),
  thinkingOptionId: z.string().regex(MODEL_NAME_PATTERN).optional(),
});

export type SharedDelegationTierRoute = z.infer<typeof delegationTierRouteSchema>;

export const delegationRoutingGetParamsSchema = z.strictObject({
  repoRoot: z.string().min(1).optional(),
  planner: z.string().min(1).optional(),
  profile: profileNameSchema.optional(),
});

export type DelegationRoutingGetParams = z.infer<typeof delegationRoutingGetParamsSchema>;

export const delegationRoutingSetParamsSchema = z.strictObject({
  /** Legacy alias for `editProfile`; never writes top-level `profile` on its own. */
  profile: profileNameSchema.optional(),
  /** Profile whose tier routes are edited without modifying top-level `profile`. */
  editProfile: profileNameSchema.optional(),
  /**
   * Explicit top-level `profile` default override.
   * `null` clears top-level `profile` to restore automatic planner-based selection;
   * `undefined` leaves top-level `profile` untouched.
   */
  defaultProfile: profileNameSchema.nullable().optional(),
  routes: z
    .strictObject({
      deep: z.string().min(1).optional(),
      light: z.string().min(1).optional(),
      review: z.string().min(1).optional(),
    })
    .optional(),
  user: z.boolean().optional(),
  repoRoot: z.string().min(1).optional(),
});

export type DelegationRoutingSetParams = z.infer<typeof delegationRoutingSetParamsSchema>;

export const delegationRoutingSnapshotSchema = z.strictObject({
  profile: z.string().min(1),
  profileReason: z.string().min(1),
  /** Configured top-level `profile` override, or `null` when automatic planner selection is active. */
  configuredDefaultProfile: z.string().min(1).nullable().optional(),
  availableProfiles: z.array(z.string().min(1)),
  routes: z.strictObject({
    deep: delegationTierRouteSchema,
    light: delegationTierRouteSchema,
    review: delegationTierRouteSchema,
  }),
  routeSpecs: z.strictObject({
    deep: z.string().min(1),
    light: z.string().min(1),
    review: z.string().min(1),
  }),
  sources: z.array(z.string()),
  userConfigPath: z.string().min(1),
  projectConfigPath: z.string().min(1).optional(),
});

export type DelegationRoutingSnapshot = z.infer<typeof delegationRoutingSnapshotSchema>;
