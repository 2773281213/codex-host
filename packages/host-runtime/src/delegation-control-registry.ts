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
  type DelegationWatchApi,
  type HarnessInspectInput,
  type HarnessListInput,
  type ThreadAnswerInput,
  type ThreadApplyInput,
  type ThreadDiscardInput,
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
  buildGovernedTaskPrompt,
  checkExecutorRoleGuard,
  validateGovernancePolicy,
} from "./delegation-policy.js";
import {
  loadDelegationRoutingConfig,
  loadDelegationRoutingLayers,
  projectDelegationRoutingPath,
  userDelegationRoutingPath,
  writeDelegationRoutingSetting,
} from "./delegation-routing.js";
import {
  applyGovernedThread,
  discardGovernedThread,
  verifyGovernedThread,
} from "./delegation-worktree-lifecycle.js";
import { resolveGitRepoRoot } from "./delegation-worktree.js";
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

function isGovernedStart(input: DelegationStartInput): boolean {
  return (
    input.tier !== undefined ||
    input.profile !== undefined ||
    (input.scope !== undefined && input.scope.length > 0) ||
    (input.checks !== undefined && input.checks.length > 0) ||
    input.acceptance !== undefined ||
    input.worktreeMetadata !== undefined ||
    input.allowNestedDelegation === false
  );
}

/** Adds references to a result only when there are some, so existing output stays unchanged. */
function withRefs<T extends object>(value: T, refs: readonly string[]): T {
  return refs.length > 0 ? { ...value, refs: [...refs] } : value;
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
  readonly #environment: NodeJS.ProcessEnv;

  constructor(
    options: {
      diagnose?: (error: unknown) => void;
      remoteRead?: (input: ThreadReadInput) => ReturnType<DelegationControlApi["read"]>;
      watchStore?: DelegationWatchStore;
      refs?: ThreadRefsStore;
      clientEvents?: ClientEventSink;
      governanceStore?: DelegationGovernanceStore;
      environment?: NodeJS.ProcessEnv;
    } = {},
  ) {
    this.#remoteRead = options.remoteRead;
    this.#refs = options.refs;
    this.#governance = options.governanceStore;
    this.#environment = options.environment ?? process.env;
    this.#watchService = new DelegationWatchService(this, {
      ...(options.diagnose ? { diagnose: options.diagnose } : {}),
      ...(options.watchStore ? { store: options.watchStore } : {}),
      ...(options.clientEvents ? { clientEvents: options.clientEvents } : {}),
      verify: (threadId) => this.verifyThread({ threadId }),
    });
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

  async start(input: DelegationStartInput) {
    const { refs: requested, ...rawStart } = input;
    // Validated before anything is created, so a bad reference never leaves a Thread behind.
    const own = normalizeRefs(requested);

    // Anti-recursion guard: governed executor Threads cannot dispatch further delegations.
    const callerParentRecord =
      rawStart.parentThreadId && !originClientName(rawStart.parentThreadId)
        ? this.#governance?.get(rawStart.parentThreadId)
        : null;
    checkExecutorRoleGuard({
      ...(rawStart.callerRole ? { callerRole: rawStart.callerRole } : {}),
      ...(callerParentRecord
        ? { callerIsExecutorThread: !callerParentRecord.allowNestedDelegation }
        : {}),
    });

    if (!isGovernedStart(rawStart)) {
      const result = await (await this.#registrationForStart(rawStart)).start(rawStart);
      if (!this.#refs) return result;
      const parent = result.parentThreadId ?? rawStart.parentThreadId;
      const inherited = parent && !originClientName(parent) ? await this.#refs.get(parent) : [];
      const refs = mergeRefs(inherited, own);
      if (refs.length > 0) await this.#refs.set(result.threadId, refs, result.cwd, result.title);
      return withRefs(result, refs);
    }

    const executeGoverned = async () => {
      const parentCandidate = rawStart.parentThreadId;
      const plannerHarnessId =
        parentCandidate && !originClientName(parentCandidate)
          ? await this.#read({ threadId: parentCandidate, view: "result" })
              .then((snapshot) => snapshot.harnessId)
              .catch(() => "unknown")
          : "unknown";
      const sourceCwd = rawStart.sourceRepoRoot ?? rawStart.cwd;
      const resolvedRepoRoot =
        rawStart.sourceRepoRoot ??
        (sourceCwd ? ((await resolveGitRepoRoot(sourceCwd)) ?? undefined) : undefined);
      const routing = loadDelegationRoutingConfig({
        ...(resolvedRepoRoot ? { repoRoot: resolvedRepoRoot } : {}),
        environment: this.#environment,
        plannerHarnessId,
        ...(rawStart.profile ? { explicitProfile: rawStart.profile } : {}),
      });

      const plan = validateGovernancePolicy({
        ...(rawStart.tier ? { tier: rawStart.tier } : {}),
        ...(rawStart.scope ? { scope: rawStart.scope } : {}),
        ...(rawStart.checks ? { checks: rawStart.checks } : {}),
        ...(rawStart.acceptance ? { acceptance: rawStart.acceptance } : {}),
        ...(resolvedRepoRoot ? { sourceRepoRoot: resolvedRepoRoot } : {}),
        existingRecords: this.#governance?.list() ?? [],
        maxLightScopeEntries: routing.light.maxScopeEntries,
      });

      const tierRoute = plan.tier ? routing.routes[plan.tier] : undefined;
      const explicitHarness =
        typeof rawStart.harnessId === "string" && rawStart.harnessId.trim()
          ? rawStart.harnessId
          : undefined;
      const resolvedHarnessId = (explicitHarness ?? tierRoute?.harnessId) as
        RoutedHarnessId | undefined;
      if (!resolvedHarnessId) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "Either harnessId or tier is required",
        );
      }
      const routeMatchesHarness = tierRoute?.harnessId === resolvedHarnessId;
      const resolvedModel =
        rawStart.model ??
        (routeMatchesHarness && tierRoute?.model
          ? harnessModelRefSchema.parse({ id: tierRoute.model })
          : undefined);
      const resolvedThinking =
        rawStart.thinkingOptionId ??
        (routeMatchesHarness && tierRoute?.thinkingOptionId
          ? harnessThinkingOptionIdSchema.parse(tierRoute.thinkingOptionId)
          : undefined);

      const shouldEnrichTask =
        plan.tier !== undefined ||
        (rawStart.scope !== undefined && rawStart.scope.length > 0) ||
        plan.checks.length > 0 ||
        plan.acceptance !== undefined;
      const allowNested = rawStart.allowNestedDelegation === true;
      const task = shouldEnrichTask
        ? buildGovernedTaskPrompt({
            task: rawStart.task,
            ...(plan.tier ? { tier: plan.tier } : {}),
            write: plan.write,
            scope: plan.scope,
            checks: plan.checks,
            ...(plan.acceptance ? { acceptance: plan.acceptance } : {}),
            ...(rawStart.worktreeMetadata?.base
              ? { baseCommit: rawStart.worktreeMetadata.base }
              : {}),
            isWorktree: Boolean(rawStart.worktreeMetadata),
            allowNestedDelegation: allowNested,
          })
        : rawStart.task;

      const startInput: DelegationStartInput = {
        ...rawStart,
        harnessId: resolvedHarnessId,
        task,
        allowNestedDelegation: allowNested,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(resolvedThinking ? { thinkingOptionId: resolvedThinking } : {}),
      };
      const result = await (await this.#registrationForStart(startInput)).start(startInput);

      let governanceSummary: DelegationGovernanceSummary | undefined;
      if (this.#governance) {
        const warnings: string[] = [];
        const wt = rawStart.worktreeMetadata;
        if (wt?.untrackedCount && wt.untrackedCount > 0) {
          const sample = wt.untracked ?? [];
          const more = wt.untrackedCount > sample.length ? ", …" : "";
          warnings.push(
            `${wt.untrackedCount} untracked file(s) are not in the worktree baseline: ${sample.join(", ")}${more}`,
          );
        }
        const now = new Date().toISOString();
        const saved = this.#governance.save({
          formatVersion: 1,
          threadId: result.threadId,
          ...((result.parentThreadId ?? rawStart.parentThreadId)
            ? { parentThreadId: result.parentThreadId ?? rawStart.parentThreadId }
            : {}),
          ...(plannerHarnessId !== "unknown" ? { plannerHarnessId } : {}),
          harnessId: result.harnessId,
          ...(plan.tier ? { tier: plan.tier } : {}),
          ...(plan.tier ? { profile: routing.profile } : {}),
          write: plan.write,
          allowNestedDelegation: allowNested,
          scope: plan.scope,
          checks: plan.checks,
          ...(plan.acceptance ? { acceptance: plan.acceptance } : {}),
          ...(resolvedRepoRoot ? { sourceRepoRoot: resolvedRepoRoot } : {}),
          ...(wt ? { worktree: wt } : {}),
          status: result.status,
          integration: "none",
          warnings,
          createdAt: now,
          updatedAt: now,
        });
        governanceSummary = summarizeGovernance(saved);
      }

      const withGov = governanceSummary ? { ...result, governance: governanceSummary } : result;
      if (!this.#refs) return withGov;
      const parent = withGov.parentThreadId ?? rawStart.parentThreadId;
      const inherited = parent && !originClientName(parent) ? await this.#refs.get(parent) : [];
      const refs = mergeRefs(inherited, own);
      if (refs.length > 0) await this.#refs.set(withGov.threadId, refs, withGov.cwd, withGov.title);
      return withRefs(withGov, refs);
    };

    return this.#governance ? this.#governance.withLock(executeGoverned) : executeGoverned();
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
    const registration = await this.#registrationForThread(input.threadId);
    if (!input.interrupt) return registration.send(input);
    const send = { threadId: input.threadId, message: input.message };
    return this.#watchService.holdNotifications(input.threadId, () =>
      interruptAndSend(registration, send),
    );
  }

  async cancel(input: Parameters<DelegationControlApi["cancel"]>[0]) {
    return this.#watchService.cancel(input.threadId, async () =>
      (await this.#registrationForThread(input.threadId)).cancel(input),
    );
  }

  async read(input: ThreadReadInput) {
    const snapshot = await this.#read(input);
    const withGovernance = this.#attachGovernance(snapshot);
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
    const snapshot = await (await this.#registrationForThread(input.threadId)).wait(input);
    const withGovernance = this.#attachGovernance(snapshot);
    return withRefs(withGovernance, (await this.#refs?.get(snapshot.threadId)) ?? []);
  }

  async answer(input: ThreadAnswerInput) {
    return (await this.#registrationForThread(input.threadId)).answer(input);
  }

  async watch(input: ThreadWatchInput) {
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

  async routingSet(input: DelegationRoutingMutateInput): Promise<DelegationRoutingMutateResult> {
    if (typeof input.key !== "string" || !input.key.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Routing key is required");
    }
    if (input.value === undefined || input.value === null || String(input.value).trim() === "") {
      throw new DelegationControlError("INVALID_ARGUMENT", "Routing value is required");
    }
    const repoRoot = input.cwd
      ? ((await resolveGitRepoRoot(path.resolve(input.cwd))) ?? undefined)
      : undefined;
    const useUserFile = input.user === true || !repoRoot;
    const file = useUserFile
      ? userDelegationRoutingPath(this.#environment)
      : projectDelegationRoutingPath(repoRoot);
    const layersBelow = useUserFile
      ? []
      : loadDelegationRoutingLayers({ environment: this.#environment }).filter(
          (layer) => layer.file !== file,
        );
    const written = writeDelegationRoutingSetting({
      file,
      key: input.key.trim(),
      value: input.value,
      layersBelow,
    });
    const routing = loadDelegationRoutingConfig({
      ...(repoRoot ? { repoRoot } : {}),
      environment: this.#environment,
    });
    return { ...written, routing };
  }

  async routingUnset(input: DelegationRoutingMutateInput): Promise<DelegationRoutingMutateResult> {
    if (typeof input.key !== "string" || !input.key.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Routing key is required");
    }
    const repoRoot = input.cwd
      ? ((await resolveGitRepoRoot(path.resolve(input.cwd))) ?? undefined)
      : undefined;
    const useUserFile = input.user === true || !repoRoot;
    const file = useUserFile
      ? userDelegationRoutingPath(this.#environment)
      : projectDelegationRoutingPath(repoRoot);
    const layersBelow = useUserFile
      ? []
      : loadDelegationRoutingLayers({ environment: this.#environment }).filter(
          (layer) => layer.file !== file,
        );
    const written = writeDelegationRoutingSetting({
      file,
      key: input.key.trim(),
      unset: true,
      layersBelow,
    });
    const routing = loadDelegationRoutingConfig({
      ...(repoRoot ? { repoRoot } : {}),
      environment: this.#environment,
    });
    return { ...written, routing };
  }

  async verifyThread(input: ThreadVerifyInput) {
    const store = this.#requireGovernanceStore();
    return verifyGovernedThread({
      threadId: input.threadId,
      api: this,
      store,
      environment: this.#environment,
    });
  }

  async applyThread(input: ThreadApplyInput) {
    const store = this.#requireGovernanceStore();
    return store.withLock(() =>
      applyGovernedThread({
        threadId: input.threadId,
        ...(input.allowOutOfScope !== undefined ? { allowOutOfScope: input.allowOutOfScope } : {}),
        ...(input.force !== undefined ? { force: input.force } : {}),
        api: this,
        store,
        environment: this.#environment,
      }),
    );
  }

  async discardThread(input: ThreadDiscardInput) {
    const store = this.#requireGovernanceStore();
    return store.withLock(() =>
      discardGovernedThread({
        threadId: input.threadId,
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

  #attachGovernance<T extends { threadId: string; status: DelegationGovernanceRecord["status"] }>(
    snapshot: T,
  ): T & { governance?: DelegationGovernanceSummary } {
    if (!this.#governance) return snapshot;
    let record = this.#governance.get(snapshot.threadId);
    if (!record) return snapshot;
    if (
      record.status !== "verifying" &&
      record.status !== snapshot.status &&
      record.integration === "none"
    ) {
      record =
        this.#governance.update(snapshot.threadId, (draft) => {
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
