import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationGovernanceApi,
  type DelegationRoutingMutateInput,
  type DelegationRoutingShowInput,
  type DelegationStartInput,
  type DelegationWatchApi,
  type HarnessInspectInput,
  type HarnessListInput,
  type PromptCacheKeepAliveApi,
  type ThreadAnswerInput,
  type ThreadApplyInput,
  type ThreadCancelInput,
  type ThreadDiscardInput,
  type ThreadKeepAliveInput,
  type ThreadListInput,
  type ThreadSendInput,
  type ThreadReadInput,
  type ThreadVerifyInput,
  type ThreadWaitInput,
  type ThreadWatchInput,
} from "./delegation-types.js";
import { matchesBearerToken } from "./bearer-token.js";
import type { HostInventory } from "./host-inventory.js";
import { validateThreadExportInput, type ThreadExportInput } from "./delegation-thread-export.js";
import { readThreadResultFile } from "./thread-result-file.js";
import { validateReadOptions } from "./delegation-snapshot.js";
import { requestsGovernance } from "./delegation-policy.js";
import { startWithDelegationWorktree } from "./delegation-worktree.js";
import { removeWorktreeCheckout } from "./delegation-worktree-lifecycle.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export function errorBody(error: unknown): {
  error: { code: string; message: string; details?: unknown };
} {
  if (error instanceof DelegationControlError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

export async function jsonBody(
  request: IncomingMessage,
  maximumBytes = MAX_REQUEST_BYTES,
): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes)
      throw new DelegationControlError("INVALID_ARGUMENT", "Request body is too large");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new DelegationControlError("INVALID_ARGUMENT", "Request body must be a JSON object");
  }
}

export interface DelegationControlServer {
  endpoint: string;
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function watchApi(api: DelegationWatchApi | undefined): DelegationWatchApi {
  if (!api)
    throw new DelegationControlError("INVALID_ARGUMENT", "This Runtime does not support watches");
  return api;
}

function governanceApi(api: DelegationGovernanceApi | undefined): DelegationGovernanceApi {
  if (!api)
    throw new DelegationControlError(
      "UNSUPPORTED",
      "This Runtime does not support delegation governance",
    );
  return api;
}

function keepAliveApi(api: PromptCacheKeepAliveApi | undefined): PromptCacheKeepAliveApi {
  if (!api)
    throw new DelegationControlError(
      "UNSUPPORTED",
      "This Runtime does not support prompt-cache keep-alive",
    );
  return api;
}

/** The Turn already started, so a watch failure is reported beside it, not thrown. */
function watchStartedTurn(watches: DelegationWatchApi, input: ThreadWatchInput) {
  return watches.watch(input).catch((error: unknown) => ({
    state: "notRegistered" as const,
    reason: error instanceof Error ? error.message : String(error),
  }));
}

/** `delegate start --watch`: the Host-resolved parent is the notified Thread. */
async function startWithWatch(
  api: DelegationControlApi,
  watches: DelegationWatchApi,
  body: Record<string, unknown>,
): Promise<unknown> {
  const { watchTimeoutMs, autoVerify, ...start } = body;
  const result = await api.start(start as unknown as DelegationStartInput);
  const watch = await watchStartedTurn(watches, {
    threadId: result.threadId,
    notifyThreadId: result.parentThreadId ?? "",
    timeoutMs: watchTimeoutMs as number,
    ...(autoVerify === true ? { autoVerify: true } : {}),
  });
  return { ...result, watch };
}

/** Send first; optional notification targets the calling Thread resolved by the CLI/listener. */
async function sendWithWatch(
  api: DelegationControlApi,
  watches: DelegationWatchApi,
  body: Record<string, unknown>,
): Promise<unknown> {
  const { watchTimeoutMs, notifyThreadId, autoVerify, ...send } = body;
  if (autoVerify === true && typeof send.threadId === "string") {
    const snapshot = await api.read({ threadId: send.threadId, view: "result" });
    if (!snapshot.governance || snapshot.governance.integration !== "none")
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "--auto-verify requires a governed delegation (--tier, --scope or --check)",
      );
  }
  const result = await api.send(send as unknown as ThreadSendInput);
  const watch = await watchStartedTurn(watches, {
    threadId: result.threadId,
    notifyThreadId: (notifyThreadId ?? "") as string,
    timeoutMs: watchTimeoutMs as number,
    ...(autoVerify === true ? { autoVerify: true } : {}),
  });
  return { ...result, watch };
}

/** The delegation routes shared by the Host control server and the external client listener. */
export async function routeDelegationRequest(
  handlers: {
    api: DelegationControlApi;
    watchApi?: DelegationWatchApi;
    governanceApi?: DelegationGovernanceApi;
    keepAliveApi?: PromptCacheKeepAliveApi;
    inventory?: HostInventory;
  },
  route: string | undefined,
  body: Record<string, unknown>,
): Promise<unknown> {
  switch (route) {
    case "/v1/host/info":
    case "/v1/project/list":
      if (!handlers.inventory)
        throw new DelegationControlError("UNSUPPORTED", "Host inventory is unavailable");
      return route === "/v1/host/info"
        ? handlers.inventory.info(body)
        : handlers.inventory.projects(body);
    case "/v1/thread/file":
      return readThreadResultFile(handlers.api, body);
    case "/v1/harness/list":
      return handlers.api.listHarnesses(body as HarnessListInput);
    case "/v1/harness/inspect":
      return handlers.api.inspect(body as unknown as HarnessInspectInput);
    case "/v1/delegate/routing/show":
      return governanceApi(handlers.governanceApi).routingShow(
        body as unknown as DelegationRoutingShowInput,
      );
    case "/v1/delegate/routing/set":
      return governanceApi(handlers.governanceApi).routingSet(
        body as unknown as DelegationRoutingMutateInput,
      );
    case "/v1/delegate/routing/unset":
      return governanceApi(handlers.governanceApi).routingUnset(
        body as unknown as DelegationRoutingMutateInput,
      );
    case "/v1/delegate/start": {
      const { worktree, base, includeUncommitted, ...start } = body;
      if (includeUncommitted !== undefined && typeof includeUncommitted !== "boolean") {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "includeUncommitted must be a boolean",
        );
      }
      const governed = requestsGovernance(start);
      const sourceCwd = typeof start.cwd === "string" ? start.cwd : undefined;
      // The Host creates governed worktrees itself; metadata from a request is never trusted.
      delete start.worktreeMetadata;
      delete start.sourceRepoRoot;
      if (!governed && start.autoVerify === true) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--auto-verify requires a governed delegation (--tier, --scope or --check)",
        );
      }
      if (
        typeof worktree === "string" &&
        worktree.trim() !== "" &&
        handlers.governanceApi?.preflightStart !== undefined
      ) {
        await handlers.governanceApi.preflightStart({
          ...(start as unknown as DelegationStartInput),
          ...(sourceCwd !== undefined ? { cwd: sourceCwd } : {}),
        });
      }
      return startWithDelegationWorktree(
        {
          cwd: sourceCwd,
          branch: worktree as string | undefined,
          base: base as string | undefined,
          includeUncommitted: includeUncommitted as boolean | undefined,
        },
        (cwd, createdWorktree, sourceRoot) => {
          const input: Record<string, unknown> = {
            ...start,
            ...(cwd !== undefined ? { cwd } : {}),
            ...(governed && createdWorktree
              ? { sourceRepoRoot: sourceRoot, worktreeMetadata: createdWorktree }
              : {}),
          };
          return input.watchTimeoutMs === undefined
            ? handlers.api.start(input as unknown as DelegationStartInput)
            : startWithWatch(handlers.api, watchApi(handlers.watchApi), input);
        },
        async (error, createdWorktree, sourceRoot) => {
          if (!governed || !createdWorktree) return false;
          if (!(error instanceof DelegationControlError) || error.details?.notStarted !== true)
            return false;
          const cleanup = await removeWorktreeCheckout(
            sourceRoot,
            createdWorktree.path,
            createdWorktree.branch,
          ).catch(() => ({ worktreeRemoved: false, branchRemoved: false }));
          return cleanup.worktreeRemoved;
        },
      );
    }
    case "/v1/thread/verify":
      return governanceApi(handlers.governanceApi).verifyThread(
        body as unknown as ThreadVerifyInput,
      );
    case "/v1/thread/apply":
      return governanceApi(handlers.governanceApi).applyThread(body as unknown as ThreadApplyInput);
    case "/v1/thread/discard":
      return governanceApi(handlers.governanceApi).discardThread(
        body as unknown as ThreadDiscardInput,
      );
    case "/v1/thread/keepalive":
      return keepAliveApi(handlers.keepAliveApi).keepAlive(body as unknown as ThreadKeepAliveInput);
    case "/v1/thread/send":
      return body.watchTimeoutMs === undefined
        ? handlers.api.send(body as unknown as ThreadSendInput)
        : sendWithWatch(handlers.api, watchApi(handlers.watchApi), body);
    case "/v1/thread/cancel":
      return handlers.api.cancel(body as unknown as ThreadCancelInput);
    case "/v1/thread/export": {
      const input = body as unknown as ThreadExportInput;
      validateThreadExportInput(input);
      if (!handlers.api.exportThread)
        throw new DelegationControlError("UNSUPPORTED", "Thread export is unavailable");
      return handlers.api.exportThread(input);
    }
    case "/v1/thread/read":
    case "/v1/thread/wait": {
      const allowed = new Set([
        "threadId",
        "view",
        "from",
        "to",
        ...(route === "/v1/thread/read" ? ["hostId", "callerThreadId"] : ["timeoutMs"]),
      ]);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key))
          throw new DelegationControlError("INVALID_ARGUMENT", `Unknown read option: ${key}`);
      }
      validateReadOptions(body as unknown as ThreadReadInput);
      return route === "/v1/thread/read"
        ? handlers.api.read(body as unknown as ThreadReadInput)
        : handlers.api.wait(body as unknown as ThreadWaitInput);
    }
    case "/v1/thread/answer":
      return handlers.api.answer(body as unknown as ThreadAnswerInput);
    case "/v1/thread/watch":
      return watchApi(handlers.watchApi).watch(body as unknown as ThreadWatchInput);
    case "/v1/thread/watches":
      return watchApi(handlers.watchApi).watches();
    case "/v1/thread/list":
      return handlers.api.list(body as unknown as ThreadListInput);
    default:
      throw new DelegationControlError("INVALID_ARGUMENT", "Unknown Runtime control route");
  }
}

export async function startDelegationControlServer(input: {
  token: string;
  api: DelegationControlApi;
  watchApi?: DelegationWatchApi;
  governanceApi?: DelegationGovernanceApi;
  keepAliveApi?: PromptCacheKeepAliveApi;
  inventory?: HostInventory;
}): Promise<DelegationControlServer> {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        writeJson(response, 405, {
          error: { code: "INVALID_ARGUMENT", message: "POST is required" },
        });
        return;
      }
      if (!matchesBearerToken(request.headers.authorization, input.token)) {
        writeJson(response, 401, {
          error: { code: "RUNTIME_UNREACHABLE", message: "Runtime token is invalid" },
        });
        return;
      }
      const body = await jsonBody(request);
      writeJson(response, 200, await routeDelegationRequest(input, request.url, body));
    })().catch((error) => {
      writeJson(response, error instanceof DelegationControlError ? 400 : 500, errorBody(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}
