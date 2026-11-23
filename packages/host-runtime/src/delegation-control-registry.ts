import { randomUUID } from "node:crypto";
import path from "node:path";

import type { RoutedHarnessId } from "@codexhost/protocol-core";
import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";

import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationControlRegistration,
  type DelegationGovernanceApi,
  type DelegationGovernanceSummary,
  type DelegationRoutingMutateInput,
  type DelegationRoutingMutateResult,
  type DelegationRoutingShowInput,
  type DelegationStartInput,
  type DelegationStartResult,
  type DelegationWatchApi,
  type HarnessInspectInput,
  type HarnessListInput,
  type PromptCacheKeepAliveApi,
  type ThreadAnswerInput,
  type ThreadApplyInput,
  type ThreadDiscardInput,
  type ThreadKeepAliveInput,
  type ThreadListInput,
  type ThreadReadInput,
  type ThreadVerifyInput,
  type ThreadWaitInput,
  type ThreadWatchInput,
} from "./delegation-types.js";
import type {
  DelegationGovernanceRecord,
  DelegationGovernanceStore,
} from "./delegation-governance-store.js";
import {
  LIVE_DELEGATION_STATUSES,
  buildGovernedTaskPrompt,
  checkExecutorRoleGuard,
  holdsWriteScope,
  requestsGovernance,
  validateGovernancePolicy,
  type NormalizedGovernancePlan,
  type ScopeHoldingRecord,
} from "./delegation-policy.js";
import {
  loadDelegationRoutingConfig,
  loadDelegationRoutingLayers,
  projectDelegationRoutingPath,
  userDelegationRoutingPath,
  writeDelegationRoutingSetting,
  type DelegationRoutingConfig,
} from "./delegation-routing.js";
import {
  applyGovernedThread,
  discardGovernedThread,
  verifyGovernedThread,
} from "./delegation-worktree-lifecycle.js";
import {
  resolveComparablePath,
  resolveGitRepoRoot,
  samePath,
  verifyDelegationWorktree,
  type DelegationWorktree,
} from "./delegation-worktree.js";
import {
  isMergedListCursor,
  listSortSeconds,
  mergeThreadListPages,
} from "./delegation-thread-list-merge.js";
import { DelegationWatchService, type ClientEventSink } from "./delegation-watch.js";
import type { DelegationWatchStore } from "./delegation-watch-store.js";
import { clientOrigin, originClientName } from "./external-client-origin.js";
import { interruptAndSend } from "./delegation-interrupt-send.js";
import { validateThreadExportInput, type ThreadExportInput } from "./delegation-thread-export.js";
import { mergeRefs, normalizeRefs, type ThreadRefsStore } from "./thread-refs.js";

const REF_CURSOR_PREFIX = "ref:";

interface PreparedGovernedBase {
  plannerHarnessId: string;
  cwd: string | undefined;
  sourceRepoRoot: string | undefined;
  worktree: DelegationWorktree | undefined;
  worktreeComparablePath: string | undefined;
  routing: DelegationRoutingConfig;
}

function summarizeGovernance(record: DelegationGovernanceRecord): DelegationGovernanceSummary {
  return {
    ...(record.tier ? { tier: record.tier } : {}),
    ...(record.profile ? { profile: record.profile } : {}),
    ...(record.plannerHarnessId ? { plannerHarnessId: record.plannerHarnessId } : {}),
    write: record.write,
    scope: [...record.scope],
    checks: [...record.checks],
    integration: record.integration,
    ...(record.verification ? { verification: record.verification } : {}),
    ...(record.checkResults ? { checkResults: record.checkResults } : {}),
    ...(record.changedFiles ? { changedFiles: [...record.changedFiles] } : {}),
    ...(record.outOfScope ? { outOfScope: [...record.outOfScope] } : {}),
    ...(record.patchPath ? { patchPath: record.patchPath } : {}),
    ...(record.patchStat ? { patchStat: record.patchStat } : {}),
    ...(record.warnings.length > 0 ? { warnings: [...record.warnings] } : {}),
  };
}

/** Adds references to a result only when there are some, so existing output stays unchanged. */
function withRefs<T extends object>(value: T, refs: readonly string[]): T {
  return refs.length > 0 ? { ...value, refs: [...refs] } : value;
}

/** Marks an error raised before the child session started, so the Host may reclaim its worktree. */
function markNotStarted(error: unknown): DelegationControlError {
  if (error instanceof DelegationControlError) {
    return new DelegationControlError(error.code, error.message, {
      ...error.details,
      notStarted: true,
    });
  }
  return new DelegationControlError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : String(error),
    { notStarted: true },
  );
}

function only<T>(values: readonly T[], message: string): T {
  const value = values.length === 1 ? values[0] : undefined;
  if (!value) {
    throw new DelegationControlError("PARENT_THREAD_AMBIGUOUS", message, {
      matchingRuntimeCount: values.length,
    });
  }
  return value;
}

export class DelegationControlRegistry
  implements DelegationControlApi, DelegationWatchApi, DelegationGovernanceApi
{
  readonly #registrations = new Set<DelegationControlRegistration>();
  // Changes whenever the session set changes, so a merged list cursor cannot outlive it. The
  // instance id keeps a cursor from matching a rebuilt Registry at the same count.
  readonly #instanceId = randomUUID();
  #registrationGeneration = 0;
  #harnessCatalog: DelegationControlRegistration | undefined;
  // Watches sit above the sessions so either end may belong to any registered session.
  readonly #watchService: DelegationWatchService;

  readonly #remoteRead:
    ((input: ThreadReadInput) => ReturnType<DelegationControlApi["read"]>) | undefined;
  readonly #refs: ThreadRefsStore | undefined;
  readonly #governance: DelegationGovernanceStore | undefined;
  /** In-flight governed starts whose scope/worktree is reserved while the child session opens. */
  readonly #pendingClaims = new Map<string, ScopeHoldingRecord>();
  /** Threads whose send is between verification invalidation and the new Turn being recorded. */
  readonly #sendingThreads = new Set<string>();
  readonly #environment: NodeJS.ProcessEnv;
  #keepAliveHandler: PromptCacheKeepAliveApi | undefined;
  readonly #watchListeners = new Set<() => void>();

  constructor(
    options: {
      diagnose?: (error: unknown) => void;
      remoteRead?: (input: ThreadReadInput) => ReturnType<DelegationControlApi["read"]>;
      watchStore?: DelegationWatchStore;
      refs?: ThreadRefsStore;
      clientEvents?: ClientEventSink;
      governanceStore?: DelegationGovernanceStore;
      environment?: NodeJS.ProcessEnv;
      keepAlive?: PromptCacheKeepAliveApi;
    } = {},
  ) {
    this.#remoteRead = options.remoteRead;
    this.#refs = options.refs;
    this.#governance = options.governanceStore;
    this.#environment = options.environment ?? process.env;
    this.#keepAliveHandler = options.keepAlive;
    this.#watchService = new DelegationWatchService(this, {
      ...(options.diagnose ? { diagnose: options.diagnose } : {}),
      ...(options.watchStore ? { store: options.watchStore } : {}),
      ...(options.clientEvents ? { clientEvents: options.clientEvents } : {}),
      verify: (threadId) => this.verifyThread({ threadId }),
      onWatchesChanged: () => {
        for (const listener of this.#watchListeners) {
          try {
            listener();
          } catch {
            /* observer errors never break watch state transitions */
          }
        }
      },
    });
  }

  /** Attaches the Host's prompt-cache keep-alive controller once the Host starts. */
  setKeepAliveHandler(handler: PromptCacheKeepAliveApi | undefined): void {
    this.#keepAliveHandler = handler;
  }

  onWatchesChanged(listener: () => void): () => void {
    this.#watchListeners.add(listener);
    return () => {
      this.#watchListeners.delete(listener);
    };
  }

  activeWatchCountsBySubscriber(): ReadonlyMap<string, number> {
    return this.#watchService.activeWatchCountsBySubscriber();
  }

  hasActiveWatchesFor(notifyThreadId: string): boolean {
    return this.#watchService.hasActiveWatchesFor(notifyThreadId);
  }

  async keepAlive(input?: ThreadKeepAliveInput) {
    if (!this.#keepAliveHandler) {
      throw new DelegationControlError(
        "UNSUPPORTED",
        "Prompt-cache keep-alive is unavailable on this Runtime",
      );
    }
    return this.#keepAliveHandler.keepAlive(input);
  }

  get size(): number {
    return this.#registrations.size;
  }

  register(
    registration: DelegationControlRegistration,
    options: { harnessCatalog?: boolean } = {},
  ): () => void {
    this.#registrations.add(registration);
    this.#registrationGeneration += 1;
    if (options.harnessCatalog) this.#harnessCatalog = registration;
    const unsubscribeIdle = registration.onThreadIdle?.((threadId) =>
      this.#watchService.nudge(threadId),
    );
    return () => {
      unsubscribeIdle?.();
      if (this.#registrations.delete(registration)) this.#registrationGeneration += 1;
      if (this.#harnessCatalog === registration) this.#harnessCatalog = undefined;
    };
  }

  async inspect(input: HarnessInspectInput) {
    if (this.#harnessCatalog) return this.#harnessCatalog.inspect(input);
    const registrations = [...this.#registrations];
    return only(
      registrations,
      "Harness inspection requires exactly one active Host Runtime session",
    ).inspect(input);
  }

  async listHarnesses(input?: HarnessListInput) {
    if (this.#harnessCatalog) return this.#harnessCatalog.listHarnesses(input);
    return only(
      [...this.#registrations],
      "Harness discovery requires exactly one active Host Runtime session",
    ).listHarnesses(input);
  }

  /** Rejects malformed governed options before any worktree or Thread exists. */
  #validateStartTypes(rawStart: Omit<DelegationStartInput, "refs">): void {
    if (
      rawStart.allowNestedDelegation !== undefined &&
      typeof rawStart.allowNestedDelegation !== "boolean"
    )
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "allowNestedDelegation must be a boolean",
      );
    if (rawStart.tier !== undefined && (typeof rawStart.tier !== "string" || !rawStart.tier.trim()))
      throw new DelegationControlError("INVALID_ARGUMENT", "tier must be a non-empty string");
    if (
      rawStart.profile !== undefined &&
      (typeof rawStart.profile !== "string" || !rawStart.profile.trim())
    )
      throw new DelegationControlError("INVALID_ARGUMENT", "profile must be a non-empty string");
  }

  /** Rejects any start by a governed executor, before anything is created. */
  #guardExecutor(rawStart: Omit<DelegationStartInput, "refs">): void {
    const parentCandidate = rawStart.parentThreadId;
    checkExecutorRoleGuard({
      ...(rawStart.callerRole ? { callerRole: rawStart.callerRole } : {}),
      callerIsExecutorThread: Boolean(
        parentCandidate &&
        !originClientName(parentCandidate) &&
        this.#governance?.isExecutorThread(parentCandidate),
      ),
    });
  }

  #sameRepoRoot(left: string, right: string): boolean {
    const normalize = (value: string) => {
      const cleaned = value.replace(/\\/gu, "/").replace(/\/+$/u, "");
      return process.platform === "win32" ? cleaned.toLowerCase() : cleaned;
    };
    return normalize(left) === normalize(right);
  }

  /**
   * Refreshes one stored live record against its Harness status. Returns true only when the
   * record stopped holding its write scope as a result (so a conflict check should retry).
   */
  async #refreshGovernanceRecordStatus(threadId: string): Promise<boolean> {
    if (!this.#governance || this.#sendingThreads.has(threadId)) return false;
    const record = this.#governance.get(threadId);
    if (!record || record.integration !== "none" || !LIVE_DELEGATION_STATUSES.has(record.status)) {
      return false;
    }
    const beforeUpdatedAt = record.updatedAt;
    let nextStatus: DelegationGovernanceRecord["status"] | undefined;
    try {
      const snapshot = await this.#read({ threadId, view: "result" });
      if (snapshot.status !== record.status) nextStatus = snapshot.status;
    } catch (error) {
      if (error instanceof DelegationControlError && error.code === "THREAD_NOT_FOUND") {
        nextStatus = "interrupted";
      } else {
        return false;
      }
    }
    if (!nextStatus) return false;
    const updated = this.#governance.update(threadId, (draft) => {
      // Never clobber a concurrent send/verify/cancel that mutated the record while we read.
      if (draft.integration !== "none" || draft.updatedAt !== beforeUpdatedAt) return;
      draft.status = nextStatus;
    });
    return updated !== null && !holdsWriteScope(updated);
  }

  /** Refreshes potentially stale live scope holders for `sourceRepoRoot` outside the store lock. */
  async #refreshLiveGovernanceRecords(sourceRepoRoot: string | undefined): Promise<void> {
    if (!this.#governance || !sourceRepoRoot) return;
    const candidates = this.#governance
      .list()
      .filter(
        (record) =>
          record.sourceRepoRoot !== undefined &&
          this.#sameRepoRoot(record.sourceRepoRoot, sourceRepoRoot) &&
          holdsWriteScope(record) &&
          LIVE_DELEGATION_STATUSES.has(record.status),
      );
    if (candidates.length === 0) return;
    await Promise.all(
      candidates.map((record) => this.#refreshGovernanceRecordStatus(record.threadId)),
    );
  }

  /**
   * Resolves parent, checkout, verified worktree and layered routing without holding the store
   * lock so slow Git/read I/O never blocks unrelated delegations.
   */
  async #prepareGovernedBase(
    rawStart: Omit<DelegationStartInput, "refs">,
  ): Promise<PreparedGovernedBase> {
    if (rawStart.profile !== undefined && !rawStart.tier)
      throw new DelegationControlError("INVALID_ARGUMENT", "--profile requires --tier");
    const parentCandidate = rawStart.parentThreadId;
    const parent =
      parentCandidate && !originClientName(parentCandidate)
        ? await this.#read({ threadId: parentCandidate, view: "result" }).catch(() => undefined)
        : undefined;
    const plannerHarnessId = parent?.harnessId ?? "unknown";
    // Without --cwd the child works in its parent's workspace, so locks and routing use that one.
    const cwd = rawStart.cwd ?? parent?.cwd;
    let sourceRepoRoot: string | undefined;
    let worktree: DelegationWorktree | undefined;
    let worktreeComparablePath: string | undefined;
    if (rawStart.worktreeMetadata !== undefined) {
      // The child's cwd is a worktree; its scope is claimed in, and applied to, the checkout it
      // was created from, never the worktree itself.
      if (rawStart.cwd === undefined)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "cwd is required with worktreeMetadata",
        );
      const verified = await verifyDelegationWorktree({
        sourceRepoRoot: rawStart.sourceRepoRoot,
        worktree: rawStart.worktreeMetadata,
        cwd: rawStart.cwd,
      });
      sourceRepoRoot = verified.root;
      worktree = verified.worktree;
      worktreeComparablePath = await resolveComparablePath(worktree.path);
    } else if (cwd) {
      sourceRepoRoot = (await resolveGitRepoRoot(path.resolve(cwd))) ?? undefined;
    }
    const routing = loadDelegationRoutingConfig({
      ...(sourceRepoRoot ? { repoRoot: sourceRepoRoot } : {}),
      environment: this.#environment,
      plannerHarnessId,
      ...(rawStart.profile ? { explicitProfile: rawStart.profile } : {}),
    });
    return {
      plannerHarnessId,
      cwd,
      sourceRepoRoot,
      worktree,
      worktreeComparablePath,
      routing,
    };
  }

  /**
   * Validates tier guardrails, worktree occupancy, scope conflicts and routed target against both
   * persisted records and in-flight reservations. Runs fast so it may execute inside `withLock`.
   */
  async #checkGovernedConflicts(
    rawStart: Omit<DelegationStartInput, "refs">,
    base: PreparedGovernedBase,
  ) {
    const records: ScopeHoldingRecord[] = [
      ...(this.#governance?.list() ?? []),
      ...this.#pendingClaims.values(),
    ];
    if (base.worktree && base.worktreeComparablePath) {
      for (const existing of records) {
        if (existing.integration !== "none" || !existing.worktree) continue;
        const retry =
          Boolean(rawStart.requestId) &&
          existing.requestId === rawStart.requestId &&
          (rawStart.parentThreadId === undefined ||
            existing.parentThreadId === rawStart.parentThreadId);
        if (retry) continue;
        if (
          !samePath(
            await resolveComparablePath(existing.worktree.path),
            base.worktreeComparablePath,
          )
        )
          continue;
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          `Worktree ${base.worktree.path} already belongs to Thread ${existing.threadId}`,
        );
      }
    }
    const plan = validateGovernancePolicy({
      ...(rawStart.tier ? { tier: rawStart.tier } : {}),
      ...(rawStart.scope ? { scope: rawStart.scope } : {}),
      ...(rawStart.checks ? { checks: rawStart.checks } : {}),
      ...(rawStart.acceptance ? { acceptance: rawStart.acceptance } : {}),
      ...(base.sourceRepoRoot ? { sourceRepoRoot: base.sourceRepoRoot } : {}),
      existingRecords: records,
      maxLightScopeEntries: base.routing.light.maxScopeEntries,
      ...(rawStart.requestId !== undefined ? { requestId: rawStart.requestId } : {}),
      ...(rawStart.parentThreadId !== undefined ? { parentThreadId: rawStart.parentThreadId } : {}),
    });

    const tierRoute = plan.tier ? base.routing.routes[plan.tier] : undefined;
    const explicitHarness =
      typeof rawStart.harnessId === "string" && rawStart.harnessId.trim()
        ? rawStart.harnessId
        : undefined;
    const harnessId = (explicitHarness ?? tierRoute?.harnessId) as RoutedHarnessId | undefined;
    if (!harnessId) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Either harnessId or tier is required");
    }
    const routeMatchesHarness = tierRoute?.harnessId === harnessId;
    const model =
      rawStart.model ??
      (routeMatchesHarness && tierRoute?.model
        ? harnessModelRefSchema.parse({ id: tierRoute.model })
        : undefined);
    const thinkingOptionId =
      rawStart.thinkingOptionId ??
      (routeMatchesHarness && tierRoute?.thinkingOptionId
        ? harnessThinkingOptionIdSchema.parse(tierRoute.thinkingOptionId)
        : undefined);
    return { plan, harnessId, model, thinkingOptionId };
  }

  /** Runs a start's checks without starting it; see {@link DelegationGovernanceApi.preflightStart}. */
  async preflightStart(input: DelegationStartInput): Promise<{ ok: true }> {
    const { refs: requested, ...rawStart } = input;
    this.#validateStartTypes(rawStart);
    normalizeRefs(requested);
    this.#guardExecutor(rawStart);
    if (!requestsGovernance(rawStart)) return { ok: true };
    const base = await this.#prepareGovernedBase(rawStart);
    await this.#refreshLiveGovernanceRecords(base.sourceRepoRoot);
    const resolved = await this.#checkGovernedConflicts(rawStart, base);
    // Fail an ambiguous or absent parent before the caller creates a worktree for this start.
    await this.#registrationForStart({ ...rawStart, harnessId: resolved.harnessId });
    return { ok: true };
  }

  async start(input: DelegationStartInput) {
    const { refs: requested, ...rawStart } = input;
    let own: string[];
    try {
      this.#validateStartTypes(rawStart);
      // Validated before anything is created, so a bad reference never leaves a Thread behind.
      own = normalizeRefs(requested);
      this.#guardExecutor(rawStart);
    } catch (error) {
      throw markNotStarted(error);
    }

    if (!requestsGovernance(rawStart)) {
      // Worktree metadata only means something to governance; ungoverned starts never persist it.
      const plainStart = { ...rawStart };
      delete plainStart.worktreeMetadata;
      delete plainStart.sourceRepoRoot;
      const result = await (await this.#registrationForStart(plainStart)).start(plainStart);
      if (!this.#refs) return result;
      const parent = result.parentThreadId ?? rawStart.parentThreadId;
      const inherited = parent && !originClientName(parent) ? await this.#refs.get(parent) : [];
      const refs = mergeRefs(inherited, own);
      if (refs.length > 0) await this.#refs.set(result.threadId, refs, result.cwd, result.title);
      return withRefs(result, refs);
    }

    let base: PreparedGovernedBase;
    try {
      base = await this.#prepareGovernedBase(rawStart);
      await this.#refreshLiveGovernanceRecords(base.sourceRepoRoot);
    } catch (error) {
      throw markNotStarted(error);
    }

    const tryReserve = async (): Promise<{
      plan: NormalizedGovernancePlan;
      harnessId: RoutedHarnessId;
      model: DelegationStartInput["model"];
      thinkingOptionId: DelegationStartInput["thinkingOptionId"];
      reservationId?: string;
    }> => {
      if (!this.#governance) {
        return this.#checkGovernedConflicts(rawStart, base);
      }
      return this.#governance.withLock(async () => {
        const resolved = await this.#checkGovernedConflicts(rawStart, base);
        const reservationId = randomUUID();
        this.#pendingClaims.set(reservationId, {
          threadId: `pending:${reservationId}`,
          write: resolved.plan.write,
          status: "creating",
          integration: "none",
          ...(base.sourceRepoRoot ? { sourceRepoRoot: base.sourceRepoRoot } : {}),
          scope: resolved.plan.scope,
          claimsScope: resolved.plan.claimsScope,
          ...(base.worktree ? { worktree: base.worktree } : {}),
          ...(rawStart.requestId ? { requestId: rawStart.requestId } : {}),
          ...(rawStart.parentThreadId ? { parentThreadId: rawStart.parentThreadId } : {}),
        });
        return { ...resolved, reservationId };
      });
    };

    let reserved: Awaited<ReturnType<typeof tryReserve>>;
    try {
      reserved = await tryReserve();
    } catch (error) {
      const conflictingId =
        error instanceof DelegationControlError &&
        error.code === "SCOPE_CONFLICT" &&
        typeof error.details?.conflictingThreadId === "string"
          ? error.details.conflictingThreadId
          : undefined;
      if (conflictingId && (await this.#refreshGovernanceRecordStatus(conflictingId))) {
        try {
          reserved = await tryReserve();
        } catch (retryError) {
          throw markNotStarted(retryError);
        }
      } else {
        throw markNotStarted(error);
      }
    }

    const { plannerHarnessId, routing, worktree } = base;
    const { plan, reservationId } = reserved;
    let result: DelegationStartResult;
    let governanceSummary: DelegationGovernanceSummary | undefined;
    const allowNested = rawStart.allowNestedDelegation === true;
    // Computed before start so malformed metadata can never leave a running unrecorded Thread.
    const warnings: string[] = [];
    if (worktree?.untrackedCount && worktree.untrackedCount > 0) {
      const sample = worktree.untracked ?? [];
      const more = worktree.untrackedCount > sample.length ? ", …" : "";
      warnings.push(
        `${worktree.untrackedCount} untracked file(s) are not in the worktree baseline: ${sample.join(", ")}${more}`,
      );
    }
    let registration: DelegationControlRegistration;
    let startInput: DelegationStartInput;
    try {
      const shouldEnrichTask =
        plan.tier !== undefined ||
        (rawStart.scope !== undefined && rawStart.scope.length > 0) ||
        plan.checks.length > 0 ||
        plan.acceptance !== undefined;
      const task = shouldEnrichTask
        ? buildGovernedTaskPrompt({
            task: rawStart.task,
            ...(plan.tier ? { tier: plan.tier } : {}),
            write: plan.write,
            scope: plan.scope,
            checks: plan.checks,
            ...(plan.acceptance ? { acceptance: plan.acceptance } : {}),
            ...(worktree?.base ? { baseCommit: worktree.base } : {}),
            isWorktree: Boolean(worktree),
            allowNestedDelegation: allowNested,
          })
        : rawStart.task;

      const startBase = { ...rawStart };
      delete startBase.worktreeMetadata;
      delete startBase.sourceRepoRoot;
      startInput = {
        ...startBase,
        harnessId: reserved.harnessId,
        task,
        allowNestedDelegation: allowNested,
        ...(base.sourceRepoRoot ? { sourceRepoRoot: base.sourceRepoRoot } : {}),
        ...(worktree ? { worktreeMetadata: worktree } : {}),
        ...(reserved.model ? { model: reserved.model } : {}),
        ...(reserved.thinkingOptionId ? { thinkingOptionId: reserved.thinkingOptionId } : {}),
      };
      registration = await this.#registrationForStart(startInput);
    } catch (error) {
      if (reservationId) this.#pendingClaims.delete(reservationId);
      throw markNotStarted(error);
    }
    try {
      // Session opening runs outside store.withLock while `#pendingClaims` guards the scope.
      result = await registration.start(startInput);

      if (this.#governance) {
        const store = this.#governance;
        governanceSummary = await store.withLock(async () => {
          // An idempotent retry returns the original Thread; never overwrite its governance record.
          const existing = store.get(result.threadId);
          if (existing) {
            if (reservationId) this.#pendingClaims.delete(reservationId);
            return summarizeGovernance(existing);
          }
          const now = new Date().toISOString();
          const effectiveCwd = result.cwd ?? base.cwd;
          const saved = store.save({
            formatVersion: 1,
            threadId: result.threadId,
            ...((result.parentThreadId ?? rawStart.parentThreadId)
              ? { parentThreadId: result.parentThreadId ?? rawStart.parentThreadId }
              : {}),
            ...(rawStart.requestId ? { requestId: rawStart.requestId } : {}),
            ...(plannerHarnessId !== "unknown" ? { plannerHarnessId } : {}),
            harnessId: result.harnessId,
            ...(plan.tier ? { tier: plan.tier } : {}),
            ...(plan.tier ? { profile: routing.profile } : {}),
            write: plan.write,
            claimsScope: plan.claimsScope,
            allowNestedDelegation: allowNested,
            scope: plan.scope,
            checks: plan.checks,
            ...(plan.acceptance ? { acceptance: plan.acceptance } : {}),
            ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
            ...(base.sourceRepoRoot ? { sourceRepoRoot: base.sourceRepoRoot } : {}),
            ...(worktree ? { worktree } : {}),
            status: result.status,
            integration: "none",
            warnings,
            createdAt: now,
            updatedAt: now,
          });
          if (reservationId) this.#pendingClaims.delete(reservationId);
          return summarizeGovernance(saved);
        });
      } else if (reservationId) {
        this.#pendingClaims.delete(reservationId);
      }
    } catch (error) {
      if (reservationId) this.#pendingClaims.delete(reservationId);
      throw error;
    }

    const withGov = governanceSummary ? { ...result, governance: governanceSummary } : result;
    if (!this.#refs) return withGov;
    const parent = withGov.parentThreadId ?? rawStart.parentThreadId;
    const inherited = parent && !originClientName(parent) ? await this.#refs.get(parent) : [];
    const refs = mergeRefs(inherited, own);
    if (refs.length > 0) await this.#refs.set(withGov.threadId, refs, withGov.cwd, withGov.title);
    return withRefs(withGov, refs);
  }

  async send(input: Parameters<DelegationControlApi["send"]>[0]) {
    if (input.interrupt !== undefined && typeof input.interrupt !== "boolean")
      throw new DelegationControlError("INVALID_ARGUMENT", "interrupt must be a boolean");
    if (input.steer !== undefined && typeof input.steer !== "boolean")
      throw new DelegationControlError("INVALID_ARGUMENT", "steer must be a boolean");
    if (input.steer && input.interrupt)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "steer and interrupt are mutually exclusive",
      );
    const performSend = async () => {
      const existing =
        typeof input.threadId === "string" && input.threadId.trim()
          ? this.#governance?.get(input.threadId)
          : null;
      if (existing && existing.integration !== "none") {
        throw new DelegationControlError(
          "ALREADY_INTEGRATED",
          `Thread ${input.threadId} was already ${existing.integration}; start a new delegation instead`,
        );
      }
      // Resuming a stopped non-worktree governed writer re-claims its write scope before running.
      let reservationId: string | undefined;
      if (
        this.#governance &&
        existing &&
        existing.write &&
        existing.claimsScope !== false &&
        !existing.worktree &&
        !LIVE_DELEGATION_STATUSES.has(existing.status) &&
        existing.sourceRepoRoot
      ) {
        const store = this.#governance;
        await this.#refreshLiveGovernanceRecords(existing.sourceRepoRoot);
        const tryReserve = () =>
          store.withLock(async () => {
            const records: ScopeHoldingRecord[] = [
              ...store.list().filter((record) => record.threadId !== existing.threadId),
              ...this.#pendingClaims.values(),
            ];
            validateGovernancePolicy({
              scope: existing.scope,
              ...(existing.sourceRepoRoot ? { sourceRepoRoot: existing.sourceRepoRoot } : {}),
              existingRecords: records,
            });
            const id = randomUUID();
            this.#pendingClaims.set(id, {
              threadId: existing.threadId,
              write: true,
              status: "running",
              integration: "none",
              ...(existing.sourceRepoRoot ? { sourceRepoRoot: existing.sourceRepoRoot } : {}),
              scope: existing.scope,
              claimsScope: true,
            });
            return id;
          });
        try {
          reservationId = await tryReserve();
        } catch (error) {
          const conflictingId =
            error instanceof DelegationControlError &&
            error.code === "SCOPE_CONFLICT" &&
            typeof error.details?.conflictingThreadId === "string"
              ? error.details.conflictingThreadId
              : undefined;
          if (conflictingId && (await this.#refreshGovernanceRecordStatus(conflictingId))) {
            try {
              reservationId = await tryReserve();
            } catch (retryError) {
              throw markNotStarted(retryError);
            }
          } else {
            throw markNotStarted(error);
          }
        }
      }
      let registration: DelegationControlRegistration;
      try {
        registration = await this.#registrationForThread(input.threadId);
      } catch (error) {
        if (reservationId) this.#pendingClaims.delete(reservationId);
        throw markNotStarted(error);
      }
      let sendAttempted = false;
      try {
        if (existing && this.#governance) {
          const store = this.#governance;
          // Do not let a concurrent refresh turn a freshly started Turn back to completed.
          this.#sendingThreads.add(input.threadId);
          await store.withLock(async () => {
            // New work invalidates prior verification and patch before it starts running.
            store.clearPatch(input.threadId);
            store.update(input.threadId, (draft) => {
              if (draft.integration !== "none") return;
              delete draft.verifiedAt;
              delete draft.verifiedTurnId;
              delete draft.verification;
              delete draft.checkResults;
              delete draft.changedFiles;
              delete draft.outOfScope;
              delete draft.patchPath;
              delete draft.patchStat;
            });
          });
        }
        sendAttempted = true;
        const result = !input.interrupt
          ? await registration.send(input)
          : await interruptAndSend(registration, {
              threadId: input.threadId,
              message: input.message,
            });
        if (existing && this.#governance) {
          const store = this.#governance;
          await store.withLock(async () => {
            store.update(input.threadId, (draft) => {
              if (draft.integration === "none") draft.status = "running";
            });
          });
        }
        if (reservationId) this.#pendingClaims.delete(reservationId);
        if (existing) this.#sendingThreads.delete(input.threadId);
        return result;
      } catch (error) {
        if (reservationId) this.#pendingClaims.delete(reservationId);
        if (existing) this.#sendingThreads.delete(input.threadId);
        if (!sendAttempted) throw markNotStarted(error);
        throw error;
      }
    };
    const lockedSend = () =>
      this.#governance && typeof input.threadId === "string" && input.threadId.trim()
        ? this.#governance.withThreadLock(input.threadId, performSend)
        : performSend();
    // Hold watch notifications before waiting on withThreadLock so in-flight autoVerify cannot
    // deliver a stale previous-turn completion notice while the follow-up send starts.
    if (input.interrupt || this.#governance) {
      return this.#watchService.holdNotifications(input.threadId, lockedSend);
    }
    return lockedSend();
  }

  async cancel(input: Parameters<DelegationControlApi["cancel"]>[0]) {
    const beforeUpdatedAt =
      typeof input.threadId === "string" && input.threadId.trim()
        ? this.#governance?.get(input.threadId)?.updatedAt
        : undefined;
    const result = await this.#watchService.cancel(input.threadId, async () =>
      (await this.#registrationForThread(input.threadId)).cancel(input),
    );
    if (result.cancelled && this.#governance) {
      this.#governance.update(input.threadId, (draft) => {
        if (
          draft.integration === "none" &&
          (beforeUpdatedAt === undefined || draft.updatedAt === beforeUpdatedAt)
        ) {
          draft.status = "interrupted";
        }
      });
    }
    return result;
  }

  async read(input: ThreadReadInput) {
    const beforeUpdatedAt =
      typeof input.threadId === "string" && input.threadId.trim()
        ? this.#governance?.get(input.threadId)?.updatedAt
        : undefined;
    const snapshot = await this.#read(input);
    const withGovernance = this.#attachGovernance(snapshot, beforeUpdatedAt);
    return withRefs(withGovernance, (await this.#refs?.get(snapshot.threadId)) ?? []);
  }

  async #read(input: ThreadReadInput) {
    const { callerThreadId, ...read } = input;
    if (read.hostId !== undefined && read.hostId !== "local") {
      if (typeof callerThreadId === "string" && callerThreadId) {
        const callers = await this.#matching(
          (registration) =>
            registration.executionHostId?.(callerThreadId) === read.hostId &&
            registration.ownsThread(callerThreadId),
        );
        if (callers.length > 0) {
          this.#selectExplicitThreadRegistration(
            callers,
            "Calling Thread has ambiguous execution Host context",
          );
          // The caller identifies the Host, but the target can belong to another session.
          const { hostId, ...local } = read;
          const snapshot = await (await this.#registrationForThread(local.threadId)).read(local);
          return { ...snapshot, hostId };
        }
      }
      if (!read.hostId || !this.#remoteRead)
        throw new DelegationControlError(
          "RUNTIME_UNREACHABLE",
          "Remote Thread reading is unavailable",
        );
      return this.#remoteRead(read);
    }
    return (await this.#registrationForThread(read.threadId)).read(read);
  }

  async exportThread(input: ThreadExportInput) {
    validateThreadExportInput(input);
    const registration = await this.#registrationForThread(input.threadId);
    if (!registration.exportThread)
      throw new DelegationControlError("UNSUPPORTED", "Thread export is unavailable");
    return registration.exportThread(input);
  }

  async wait(input: ThreadWaitInput) {
    if (input.hostId !== undefined && input.hostId !== "local")
      throw new DelegationControlError("INVALID_ARGUMENT", "Remote Hosts support thread read only");
    const beforeUpdatedAt =
      typeof input.threadId === "string" && input.threadId.trim()
        ? this.#governance?.get(input.threadId)?.updatedAt
        : undefined;
    const snapshot = await (await this.#registrationForThread(input.threadId)).wait(input);
    const withGovernance = this.#attachGovernance(snapshot, beforeUpdatedAt);
    return withRefs(withGovernance, (await this.#refs?.get(snapshot.threadId)) ?? []);
  }

  async answer(input: ThreadAnswerInput) {
    return (await this.#registrationForThread(input.threadId)).answer(input);
  }

  async watch(input: ThreadWatchInput) {
    if (input.autoVerify === true) {
      const record = this.#governance?.get(input.threadId);
      if (!record || record.integration !== "none")
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--auto-verify requires a governed delegation (--tier, --scope or --check)",
        );
    }
    return this.#watchService.watch(input);
  }

  async watches() {
    return this.#watchService.watches();
  }

  async routingShow(input: DelegationRoutingShowInput = {}) {
    const repoRoot = input.cwd
      ? ((await resolveGitRepoRoot(path.resolve(input.cwd))) ?? undefined)
      : undefined;
    return loadDelegationRoutingConfig({
      ...(repoRoot ? { repoRoot } : {}),
      environment: this.#environment,
      ...(input.planner ? { plannerHarnessId: input.planner } : {}),
      ...(input.profile ? { explicitProfile: input.profile } : {}),
    });
  }

  async #resolveRoutingMutationTarget(input: { cwd?: string; user?: boolean }): Promise<{
    repoRoot: string | undefined;
    file: string;
    scope: "user" | "project";
    layersBelow: ReturnType<typeof loadDelegationRoutingLayers>;
  }> {
    const repoRoot = input.cwd
      ? ((await resolveGitRepoRoot(path.resolve(input.cwd))) ?? undefined)
      : undefined;
    if (input.user === false && !repoRoot) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Project routing config requires a Git repository (--cwd inside a repo)",
      );
    }
    const useUserFile = input.user === true || !repoRoot;
    const userFile = userDelegationRoutingPath(this.#environment);
    const file = useUserFile ? userFile : projectDelegationRoutingPath(repoRoot);
    const comparableFile = await resolveComparablePath(file);
    const comparableUserFile = await resolveComparablePath(userFile);
    const scope: "user" | "project" = samePath(comparableFile, comparableUserFile)
      ? "user"
      : "project";
    let layersBelow: ReturnType<typeof loadDelegationRoutingLayers> = [];
    if (scope !== "user") {
      const userLayers = loadDelegationRoutingLayers({ environment: this.#environment });
      const filtered: ReturnType<typeof loadDelegationRoutingLayers> = [];
      for (const layer of userLayers) {
        if (!samePath(await resolveComparablePath(layer.file), comparableFile)) {
          filtered.push(layer);
        }
      }
      layersBelow = filtered;
    }
    return { repoRoot, file, scope, layersBelow };
  }

  #routingMutationResult(
    written: ReturnType<typeof writeDelegationRoutingSetting>,
    repoRoot: string | undefined,
  ): DelegationRoutingMutateResult {
    try {
      return {
        ...written,
        routing: loadDelegationRoutingConfig({
          ...(repoRoot ? { repoRoot } : {}),
          environment: this.#environment,
        }),
      };
    } catch (error) {
      const projectFile = repoRoot
        ? path.join(repoRoot, ".codexhost", "delegation-routing.json")
        : undefined;
      return {
        ...written,
        warning: `Routing was written to ${written.file}, but the combined configuration is invalid${projectFile ? ` (check project routing file ${projectFile})` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async routingSet(input: DelegationRoutingMutateInput): Promise<DelegationRoutingMutateResult> {
    if (typeof input.key !== "string" || !input.key.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Routing key is required");
    }
    if (input.value === undefined || input.value === null || String(input.value).trim() === "") {
      throw new DelegationControlError("INVALID_ARGUMENT", "Routing value is required");
    }
    const { repoRoot, file, scope, layersBelow } = await this.#resolveRoutingMutationTarget(input);
    const written = writeDelegationRoutingSetting({
      file,
      key: input.key.trim(),
      value: input.value,
      scope,
      environment: this.#environment,
      layersBelow,
    });
    return this.#routingMutationResult(written, repoRoot);
  }

  async routingUnset(input: DelegationRoutingMutateInput): Promise<DelegationRoutingMutateResult> {
    if (typeof input.key !== "string" || !input.key.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Routing key is required");
    }
    const { repoRoot, file, scope, layersBelow } = await this.#resolveRoutingMutationTarget(input);
    const written = writeDelegationRoutingSetting({
      file,
      key: input.key.trim(),
      unset: true,
      scope,
      environment: this.#environment,
      layersBelow,
    });
    return this.#routingMutationResult(written, repoRoot);
  }

  #requireThreadId(threadId: unknown): string {
    if (typeof threadId !== "string" || !threadId.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
    }
    return threadId.trim();
  }

  async verifyThread(input: ThreadVerifyInput) {
    const threadId = this.#requireThreadId(input?.threadId);
    const store = this.#requireGovernanceStore();
    return store.withThreadLock(threadId, () =>
      verifyGovernedThread({
        threadId,
        api: this,
        store,
        environment: this.#environment,
      }),
    );
  }

  async applyThread(input: ThreadApplyInput) {
    const threadId = this.#requireThreadId(input?.threadId);
    const store = this.#requireGovernanceStore();
    return store.withThreadLock(threadId, () =>
      applyGovernedThread({
        threadId,
        ...(input.allowOutOfScope !== undefined ? { allowOutOfScope: input.allowOutOfScope } : {}),
        ...(input.force !== undefined ? { force: input.force } : {}),
        api: this,
        store,
        environment: this.#environment,
        withSourceLock: <T>(operation: () => Promise<T>) => store.withLock(operation),
      }),
    );
  }

  async discardThread(input: ThreadDiscardInput) {
    const threadId = this.#requireThreadId(input?.threadId);
    const store = this.#requireGovernanceStore();
    return store.withThreadLock(threadId, () =>
      discardGovernedThread({
        threadId,
        api: this,
        store,
      }),
    );
  }

  #requireGovernanceStore(): DelegationGovernanceStore {
    if (!this.#governance) {
      throw new DelegationControlError(
        "UNSUPPORTED",
        "Delegation governance store is unavailable on this Runtime",
      );
    }
    return this.#governance;
  }

  #attachGovernance<
    T extends {
      threadId: string;
      status: DelegationGovernanceRecord["status"];
      turn?: { turnId: string } | null;
    },
  >(snapshot: T, beforeUpdatedAt?: string): T & { governance?: DelegationGovernanceSummary } {
    if (!this.#governance) return snapshot;
    let record = this.#governance.get(snapshot.threadId);
    if (!record) return snapshot;
    const preserveVerificationFailure =
      snapshot.status === "completed" &&
      record.status === "failed" &&
      record.verification === "failed" &&
      record.verifiedAt !== undefined &&
      (!snapshot.turn?.turnId ||
        !record.verifiedTurnId ||
        snapshot.turn.turnId === record.verifiedTurnId);
    const mutatedConcurrently =
      beforeUpdatedAt !== undefined && record.updatedAt !== beforeUpdatedAt;
    if (
      !this.#sendingThreads.has(snapshot.threadId) &&
      !mutatedConcurrently &&
      !preserveVerificationFailure &&
      record.status !== snapshot.status &&
      record.integration === "none"
    ) {
      record =
        this.#governance.update(snapshot.threadId, (draft) => {
          if (draft.integration !== "none") return;
          if (beforeUpdatedAt !== undefined && draft.updatedAt !== beforeUpdatedAt) return;
          draft.status = snapshot.status;
        }) ?? record;
    }
    return { ...snapshot, governance: summarizeGovernance(record) };
  }

  /** Stops watching in this process; stored watches resume in the next Runtime. */
  close(): void {
    this.#watchService.close();
  }

  async list(input: ThreadListInput) {
    const { client, ref, ...rest } = input;
    if (client !== undefined && rest.parentThreadId)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "--client and --parent cannot be combined",
      );
    if (ref !== undefined) return this.#listByRef(ref, rest);
    const page = await this.#list(
      client !== undefined ? { ...rest, parentThreadId: clientOrigin(client) } : rest,
    );
    if (!this.#refs) return page;
    const refs = this.#refs;
    return {
      ...page,
      threads: await Promise.all(
        page.threads.map(async (thread) => withRefs(thread, await refs.get(thread.threadId))),
      ),
    };
  }

  /** Threads carrying a reference, newest first; each row is read from its owning session. */
  async #listByRef(ref: string, input: Omit<ThreadListInput, "client" | "ref">) {
    const [normalized] = normalizeRefs([ref]);
    const matches = normalized && this.#refs ? await this.#refs.find(normalized) : [];
    let offset = 0;
    if (input.cursor) {
      const value = input.cursor.startsWith(REF_CURSOR_PREFIX)
        ? Number(input.cursor.slice(REF_CURSOR_PREFIX.length))
        : Number.NaN;
      if (!Number.isSafeInteger(value) || value < 0)
        throw new DelegationControlError("INVALID_ARGUMENT", "List cursor is invalid");
      offset = value;
    }
    const window = matches.slice(offset, offset + input.limit);
    const rows = await Promise.all(
      window.map(({ threadId, cwd, title }) =>
        this.read({ threadId, view: "result" })
          .then((snapshot) => {
            const resolvedTitle = snapshot.title ?? title;
            return withRefs(
              {
                threadId,
                harnessId: snapshot.harnessId,
                deepLink: `codex://threads/${threadId}`,
                status: snapshot.status,
                ...(cwd ? { cwd } : {}),
                ...(resolvedTitle ? { title: resolvedTitle } : {}),
              },
              snapshot.refs ?? [],
            );
          })
          // A Thread deleted since its references were stored is left out.
          .catch(() => undefined),
      ),
    );
    const next = offset + window.length;
    return {
      threads: rows.filter((row) => row !== undefined),
      nextCursor: next < matches.length ? `${REF_CURSOR_PREFIX}${next}` : null,
    };
  }

  async #list(input: ThreadListInput) {
    // Parent list owners validate their own source-bound continuation, including
    // merged cursors when SSH combines legacy and shared children.
    if (input.parentThreadId) {
      return (await this.#registrationForThread(input.parentThreadId)).list(input);
    }
    if (this.#harnessCatalog && input.cursor && isMergedListCursor(input.cursor)) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "List cursor does not match the current Thread list source",
      );
    }
    // Shared-backend catalogs see all native and external Threads. Attached
    // clients are not independent list sources.
    if (this.#harnessCatalog) return this.#harnessCatalog.list(input);
    const registrations = [...this.#registrations];
    if (registrations.length === 0) {
      throw new DelegationControlError(
        "PARENT_THREAD_AMBIGUOUS",
        "Thread list requires an active Host Runtime session",
        { matchingRuntimeCount: 0 },
      );
    }
    if (registrations.length === 1) {
      // A merged cursor was issued for several sessions; its positions mean nothing to one.
      if (input.cursor && isMergedListCursor(input.cursor)) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "List cursor does not match the active Host Runtime sessions",
        );
      }
      return only(registrations, "unreachable").list(input);
    }
    // Registration order is insertion order, which the merged cursor's session positions follow.
    return mergeThreadListPages(
      registrations.map((registration) => (page: ThreadListInput) => registration.list(page)),
      input,
      (left, right) => this.#compareThreads(left, right, input.sort),
      `${this.#instanceId}:${this.#registrationGeneration}`,
    );
  }

  async #registrationForStart(input: DelegationStartInput): Promise<DelegationControlRegistration> {
    if (originClientName(input.parentThreadId)) {
      // A client is no session's Thread, so the shared catalog or the only session takes it.
      if (this.#harnessCatalog) return this.#harnessCatalog;
      return only(
        [...this.#registrations],
        "External client work needs exactly one active Host Runtime session",
      );
    }
    const matches = await this.#matching((registration) => registration.canHandleStart(input));
    if (input.parentThreadId) {
      return this.#selectExplicitThreadRegistration(
        matches,
        "Parent Thread is not owned by exactly one active Host Runtime session",
      );
    }
    return only(
      matches,
      "Parent Thread cannot be inferred uniquely; pass --parent-thread explicitly",
    );
  }

  #selectExplicitThreadRegistration(
    matches: readonly DelegationControlRegistration[],
    message: string,
  ): DelegationControlRegistration {
    // Several attached clients can observe the catalog's same shared Thread.
    if (matches.length > 1 && this.#harnessCatalog && matches.includes(this.#harnessCatalog))
      return this.#harnessCatalog;
    return only(matches, message);
  }

  async #registrationForThread(threadId: string): Promise<DelegationControlRegistration> {
    const registrations = [...this.#registrations];
    const matches = await this.#matching((registration) => registration.ownsThread(threadId));
    if (matches.length > 0) {
      return this.#selectExplicitThreadRegistration(
        matches,
        "Thread is not owned by exactly one active Host Runtime session",
      );
    }
    if (this.#harnessCatalog) return this.#harnessCatalog;
    if (registrations.length === 0) {
      throw new DelegationControlError(
        "PARENT_THREAD_AMBIGUOUS",
        "Thread is not owned by exactly one active Host Runtime session",
        { matchingRuntimeCount: 0 },
      );
    }
    // When only one runtime session exists, forward unknown thread IDs to it so it can attempt official fallback (or return THREAD_NOT_FOUND).
    if (registrations.length === 1) return registrations[0] as DelegationControlRegistration;
    throw new DelegationControlError(
      "PARENT_THREAD_AMBIGUOUS",
      "Thread is not owned by exactly one active Host Runtime session",
      { matchingRuntimeCount: 0 },
    );
  }

  #compareThreads(
    left: Awaited<ReturnType<DelegationControlApi["list"]>>["threads"][number],
    right: Awaited<ReturnType<DelegationControlApi["list"]>>["threads"][number],
    sort: ThreadListInput["sort"],
  ): number {
    const seconds = (thread: typeof left): number | undefined =>
      sort.startsWith("created")
        ? listSortSeconds(thread, "createdAt")
        : sort.startsWith("recency")
          ? (listSortSeconds(thread, "recencyAt") ?? listSortSeconds(thread, "updatedAt"))
          : listSortSeconds(thread, "updatedAt");
    const direction = sort.endsWith("asc") ? 1 : -1;
    const leftValue = seconds(left) ?? 0;
    const rightValue = seconds(right) ?? 0;
    return (leftValue - rightValue) * direction || left.threadId.localeCompare(right.threadId);
  }

  async #matching(
    predicate: (registration: DelegationControlRegistration) => boolean | Promise<boolean>,
  ): Promise<DelegationControlRegistration[]> {
    const registrations = [...this.#registrations];
    const matches = await Promise.all(registrations.map((registration) => predicate(registration)));
    return registrations.filter((_, index) => matches[index]);
  }
}
