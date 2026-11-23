import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { expect, it, vi } from "vitest";

import type { AppServerHostOptions } from "../src/app-server-host.js";
import type * as RemoteAppServer from "../src/remote-app-server.js";
import type {
  DelegationControlApi,
  DelegationControlRegistration,
  DelegationThreadListResult,
  PromptCacheKeepAliveApi,
} from "../src/delegation-types.js";

const state = vi.hoisted(() => ({
  api: undefined as DelegationControlApi | undefined,
  keepAliveApi: undefined as PromptCacheKeepAliveApi | undefined,
  hosts: [] as AppServerHostOptions[],
  lists: [] as ReturnType<typeof vi.fn>[],
  unregisters: [] as Array<(() => void) | undefined>,
  keepAliveCalls: [] as Array<Array<{ action?: string; threadId?: string }>>,
  createRemoteSession: undefined as (() => unknown) | undefined,
  result: undefined as DelegationThreadListResult | undefined,
  keepAliveWhileAttached: undefined as
    Awaited<ReturnType<PromptCacheKeepAliveApi["keepAlive"]>> | undefined,
  keepAliveAfterDetach: undefined as
    Awaited<ReturnType<PromptCacheKeepAliveApi["keepAlive"]>> | undefined,
  keepAliveAfterGlobalPause: undefined as
    Awaited<ReturnType<PromptCacheKeepAliveApi["keepAlive"]>> | undefined,
  store: { initialize: vi.fn(async () => {}), close: vi.fn(async () => {}) },
  scope: {},
}));

vi.mock("../src/app-server-host.js", () => ({
  AppServerHost: class {
    readonly #index: number;
    readonly #calls: Array<{ action?: string; threadId?: string }> = [];
    #globalPaused: string | null = null;
    readonly #pausedThreads = new Map<string, string>();
    readonly promptCacheKeepAliveApi: PromptCacheKeepAliveApi;

    constructor(options: AppServerHostOptions) {
      this.#index = state.hosts.length;
      state.hosts.push(options);
      state.keepAliveCalls.push(this.#calls);
      const list = vi.fn(async () => ({
        threads: [{ threadId: "native", harnessId: "codex", deepLink: "", status: "completed" }],
        nextCursor: "native-cursor",
      }));
      state.lists.push(list);
      this.promptCacheKeepAliveApi = {
        keepAlive: async (input) => {
          const request = input ?? {};
          this.#calls.push(request);
          if (request.action === "off") {
            if (request.threadId) this.#pausedThreads.set(request.threadId, "off");
            else this.#globalPaused = "off";
          } else if (request.action === "on") {
            if (request.threadId) this.#pausedThreads.delete(request.threadId);
            else {
              this.#globalPaused = null;
              this.#pausedThreads.clear();
            }
          }
          const threadId = `host-${this.#index}-thread`;
          return {
            settings: { enabled: false, intervalMinutes: 55, ceilingHours: 8 },
            globalPaused: this.#globalPaused,
            threads: [
              {
                threadId,
                harnessId: "claude-code",
                watchedCount: 0,
                lastRequestAt: 1000 + this.#index,
                lastRefreshAt: null,
                retryAfter: null,
                refreshes: 0,
                lastCacheReadTokens: null,
                lastCacheWriteTokens: null,
                paused: this.#pausedThreads.get(threadId) ?? this.#globalPaused,
                lastDecision: null,
                compactions: [],
              },
            ],
          };
        },
      };
      const unregister = options.onDelegationApi?.({
        list,
      } as unknown as DelegationControlRegistration);
      state.unregisters.push(unregister);
    }
    async run() {
      const api = state.api;
      const keepAliveApi = state.keepAliveApi;
      if (!api || !keepAliveApi) throw new Error("Missing delegation Registry");
      state.result = await api.list({ limit: 2, sort: "created-desc" });
      state.keepAliveWhileAttached = await keepAliveApi.keepAlive({});
      // Pause globally and for specific threads, delete one thread, then connect another secondary Host.
      await keepAliveApi.keepAlive({ action: "off" });
      await keepAliveApi.keepAlive({ action: "off", threadId: "host-2-thread" });
      await keepAliveApi.keepAlive({ action: "off", threadId: "deleted-thread" });
      state.hosts[0]?.onPromptCacheThreadDeleted?.("deleted-thread");
      state.createRemoteSession?.();
      // Let replayed pause promises settle.
      await Promise.resolve();
      state.keepAliveAfterGlobalPause = await keepAliveApi.keepAlive({});
      // Detach both secondary sessions (simulating their run() exiting) and confirm removal.
      state.unregisters[1]?.();
      state.unregisters[2]?.();
      await keepAliveApi.keepAlive({ action: "on" });
      state.keepAliveAfterDetach = await keepAliveApi.keepAlive({});
      return 0;
    }
  },
  officialEnvironment: (environment: NodeJS.ProcessEnv) => environment,
}));
vi.mock("../src/native-account-host.js", () => ({
  prepareLocalCodex: async () => ({
    officialRuntimeScope: state.scope,
    accountControl: {},
    close: async () => {},
  }),
}));
vi.mock("../src/delegation-control-server.js", () => ({
  startDelegationControlServer: async ({
    api,
    keepAliveApi,
  }: {
    api: DelegationControlApi;
    keepAliveApi?: PromptCacheKeepAliveApi;
  }) => {
    state.api = api;
    state.keepAliveApi = keepAliveApi;
    return { endpoint: "http://127.0.0.1:1", close: async () => {} };
  },
}));
vi.mock("../src/delegation-skill.js", () => ({ installDelegationSkills: async () => [] }));
vi.mock("../src/installed-harness-plugins.js", () => ({
  installedHarnessPluginOptions: () => ({}),
}));
vi.mock("../src/external-thread-repository.js", () => ({
  createProductionExternalThreadStore: () => state.store,
}));
vi.mock("../src/model-prices.js", () => ({
  ModelPriceCatalog: class {
    async start() {}
  },
  defaultModelPriceDirectory: () => "/synthetic/prices",
}));
vi.mock("../src/usage-statistics.js", () => ({ UsageStatistics: vi.fn() }));
vi.mock("../src/remote-control-app-server.js", () => ({
  createRemoteControlAppServerPlan: ({ environment }: { environment: NodeJS.ProcessEnv }) => ({
    environment,
    officialArguments: [],
    pipePath: "\\\\.\\pipe\\synthetic-catalog-test",
  }),
  publishRemoteControlAppServerDescriptor: async () => {},
}));
vi.mock("../src/remote-app-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteAppServer>()),
  createRemoteAppServerWebSocketListener: (options: {
    createSession(streams: {
      input: PassThrough;
      output: PassThrough;
      diagnosticOutput: PassThrough;
    }): unknown;
  }) => ({
    async listen() {
      const spawn = () =>
        options.createSession({
          input: new PassThrough(),
          output: new PassThrough(),
          diagnosticOutput: new PassThrough(),
        });
      state.createRemoteSession = spawn;
      spawn();
    },
    async close() {},
  }),
}));

it("registers the primary Remote Control Host as the catalog for its attached sessions", async () => {
  // Exercise the production composition without installing skills or starting a native process.
  const { runHostRuntime } = await import("../src/run-host-runtime.js");
  expect(
    await runHostRuntime({
      arguments: [],
      environment: {
        CODEXHOST_STOCK_CODEX_PATH: "/synthetic/codex",
        // Keep the user's watches, clients and listener port out of the test.
        CODEXHOST_DATA_DIR: await mkdtemp(path.join(os.tmpdir(), "codexhost-runtime-")),
        CODEXHOST_EXTERNAL_CLIENT_PORT: "off",
      },
    }),
  ).toBe(0);
  expect(state.hosts).toHaveLength(3);
  for (const host of state.hosts) {
    expect(host.mappingStore).toBe(state.store);
    expect(host.officialRuntimeScope).toBe(state.scope);
  }
  expect(state.lists[0]).toHaveBeenCalledExactlyOnceWith({ limit: 2, sort: "created-desc" });
  expect(state.lists[1]).not.toHaveBeenCalled();
  expect(state.result?.threads.map((entry) => entry.threadId)).toEqual(["native"]);
  expect(state.result?.nextCursor).toBe("native-cursor");

  // Secondary RC Host is included in keep-alive aggregation while attached.
  expect(state.keepAliveWhileAttached?.threads.map((entry) => entry.threadId)).toEqual([
    "host-0-thread",
    "host-1-thread",
  ]);
  // Newly attached secondary Host receives replayed global & per-thread pause state.
  expect(state.keepAliveAfterGlobalPause?.globalPaused).toBe("off");
  expect(state.keepAliveAfterGlobalPause?.threads.map((entry) => entry.threadId)).toEqual([
    "host-0-thread",
    "host-1-thread",
    "host-2-thread",
  ]);
  expect(state.keepAliveCalls[2]).toEqual(
    expect.arrayContaining([{ action: "off" }, { action: "off", threadId: "host-2-thread" }]),
  );
  expect(state.keepAliveCalls[2]).not.toEqual(
    expect.arrayContaining([{ action: "off", threadId: "deleted-thread" }]),
  );
  // Secondary Hosts are removed from aggregation once unregistered.
  expect(state.keepAliveAfterDetach?.threads.map((entry) => entry.threadId)).toEqual([
    "host-0-thread",
  ]);
  expect(state.keepAliveAfterDetach?.globalPaused).toBeNull();
});
