import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const CHECK_TIMEOUT_EXIT_CODE = 124;
export const CHECK_KILL_GRACE_MS = 5_000;
export const CHECK_CLOSE_GRACE_MS = 2_000;
export const CHECK_REDACTED = "[redacted]";

const MAX_LOG_CHARS = 5 * 1024 * 1024;
const MAX_STDOUT_CHARS = 2 * 1024 * 1024;
const MAX_STDERR_CHARS = 512 * 1024;
const MIN_SECRET_CHARS = 6;

export type DelegationCheckStatus = "passed" | "failed" | "not-run";
export type DelegationVerificationStatus = "passed" | "failed" | "not-run" | "unverified";

export interface DelegationCheckResult {
  command: string;
  status: DelegationCheckStatus;
  /** Passed requires 0, failed requires non-zero, not-run requires null (Birdview semantics). */
  exitCode: number | null;
  summary: string;
  durationMs?: number;
  log?: string;
}

/** Terminates a child process together with its entire process tree (taskkill on Windows, process group on POSIX). */
export function killCheckProcessTree(
  pid: number,
  options: { signal?: NodeJS.Signals; platform?: NodeJS.Platform } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const signal = options.signal ?? "SIGTERM";
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === "win32") {
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    const taskkill =
      root && path.win32.isAbsolute(root)
        ? path.win32.join(root, "System32", "taskkill.exe")
        : "taskkill.exe";
    const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 5_000,
    });
    return result.status === 0;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/** Streaming secret redactor that handles credential values split across chunk boundaries. */
export function createStreamRedactor(values: readonly string[] = []): {
  push(chunk: Buffer): string;
  end(): string;
} {
  const secrets = [
    ...new Set(
      values.filter((value) => typeof value === "string" && value.length >= MIN_SECRET_CHARS),
    ),
  ].sort((a, b) => b.length - a.length);
  const decoder = new StringDecoder("utf8");
  if (secrets.length === 0) {
    return { push: (chunk) => decoder.write(chunk), end: () => decoder.end() };
  }
  const scrub = (text: string) =>
    secrets.reduce((accumulator, secret) => accumulator.split(secret).join(CHECK_REDACTED), text);
  const hold = (secrets[0]?.length ?? 1) - 1;
  let carry = "";
  return {
    push(chunk) {
      const text = scrub(carry + decoder.write(chunk));
      const cut = Math.max(0, text.length - hold);
      carry = text.slice(cut);
      return text.slice(0, cut);
    },
    end() {
      const rest = scrub(carry + decoder.end());
      carry = "";
      return rest;
    },
  };
}

export function redactSensitiveText(text: string, values: readonly string[] = []): string {
  if (!values.length || !text) return text;
  const redactor = createStreamRedactor(values);
  return redactor.push(Buffer.from(text, "utf8")) + redactor.end();
}

function signalNumber(signal: NodeJS.Signals): number {
  const map = os.constants.signals as Record<string, number | undefined>;
  return map[signal] ?? 1;
}

class BoundedCapture {
  readonly #limit: number;
  readonly #parts: string[] = [];
  #size = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(text: string): void {
    if (!text || this.#size >= this.#limit) return;
    const piece =
      text.length > this.#limit - this.#size ? text.slice(0, this.#limit - this.#size) : text;
    this.#parts.push(piece);
    this.#size += piece.length;
  }

  text(): string {
    return this.#parts.join("");
  }
}

interface CommandRunOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

function runShellCheckCommand(input: {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  logFile?: string;
  signal?: AbortSignal;
  redact?: readonly string[];
  shell?: string;
  platform?: NodeJS.Platform;
}): Promise<CommandRunOutcome> {
  const platform = input.platform ?? process.platform;
  return new Promise((resolve) => {
    const started = Date.now();
    const log = input.logFile ? fs.createWriteStream(input.logFile, { flags: "a" }) : null;
    let logged = 0;
    const writeLog = (text: string) => {
      if (!log || !text || logged >= MAX_LOG_CHARS) return;
      logged += text.length;
      log.write(text);
      if (logged >= MAX_LOG_CHARS) log.write("\n[codexhost: check log truncated]\n");
    };
    const stdout = new BoundedCapture(MAX_STDOUT_CHARS);
    const stderr = new BoundedCapture(MAX_STDERR_CHARS);
    const outRedactor = createStreamRedactor(input.redact);
    const errRedactor = createStreamRedactor(input.redact);
    const take = (capture: BoundedCapture, text: string) => {
      capture.push(text);
      writeLog(text);
    };
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;

    const finish = (outcome: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      spawnError?: Error;
    }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      input.signal?.removeEventListener("abort", onAbort);
      take(stdout, outRedactor.end());
      take(stderr, errRedactor.end());
      const done = () =>
        resolve({
          ...outcome,
          timedOut,
          cancelled,
          durationMs: Date.now() - started,
          stdout: stdout.text(),
          stderr: stderr.text(),
        });
      if (log) log.end(done);
      else done();
    };

    const stop = () => {
      const pid = child?.pid;
      if (!pid) return;
      killCheckProcessTree(pid, { signal: "SIGTERM", platform });
      if (platform !== "win32") {
        killTimer = setTimeout(
          () => killCheckProcessTree(pid, { signal: "SIGKILL", platform }),
          CHECK_KILL_GRACE_MS,
        );
        killTimer.unref?.();
      }
    };

    const onAbort = () => {
      cancelled = true;
      stop();
    };

    try {
      child = spawn(input.command, {
        cwd: input.cwd,
        env: input.env ?? process.env,
        shell: input.shell ?? true,
        detached: platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        exitCode: null,
        signal: null,
        spawnError: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    if (input.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, input.timeoutMs);
      timer.unref?.();
    }
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => take(stdout, outRedactor.push(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => take(stderr, errRedactor.push(chunk)));
    child.on("error", (error) => finish({ exitCode: null, signal: null, spawnError: error }));
    let exited: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on("exit", (code, sig) => {
      exited = { exitCode: code, signal: sig };
      if (platform !== "win32" && child?.pid) {
        killCheckProcessTree(child.pid, { signal: "SIGKILL", platform });
      }
      closeTimer = setTimeout(() => {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        finish(exited ?? { exitCode: code, signal: sig });
      }, CHECK_CLOSE_GRACE_MS);
      closeTimer.unref?.();
    });
    child.on("close", (code, sig) => finish(exited ?? { exitCode: code, signal: sig }));
  });
}

function recordedExitCode(run: CommandRunOutcome): number {
  if (run.timedOut) return CHECK_TIMEOUT_EXIT_CODE;
  if (Number.isInteger(run.exitCode)) return run.exitCode as number;
  if (run.signal) return 128 + signalNumber(run.signal);
  return 1;
}

function lastNonEmptyLine(text: string): string {
  const lines = text
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "");
  const last = lines.at(-1) ?? "";
  return last.length > 240 ? `${last.slice(0, 239)}…` : last;
}

export function checksNotRun(commands: readonly string[], reason: string): DelegationCheckResult[] {
  return commands.map((command) => ({
    command,
    status: "not-run",
    exitCode: null,
    summary: reason,
  }));
}

/** Runs declared verification commands sequentially inside the delegated workspace/worktree. */
export async function runDelegationChecks(
  commands: readonly string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    logDir?: string;
    signal?: AbortSignal;
    redact?: readonly string[];
    shell?: string;
    platform?: NodeJS.Platform;
  },
): Promise<DelegationCheckResult[]> {
  if (commands.length === 0) return [];
  if (options.logDir) fs.mkdirSync(options.logDir, { recursive: true });
  const results: DelegationCheckResult[] = [];
  for (const [index, command] of commands.entries()) {
    if (options.signal?.aborted) {
      results.push(...checksNotRun(commands.slice(index), "not run: verification cancelled"));
      break;
    }
    const logFile = options.logDir ? path.join(options.logDir, `${index}.log`) : undefined;
    const run = await runShellCheckCommand({
      command,
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      timeoutMs: options.timeoutMs,
      ...(logFile ? { logFile } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.redact ? { redact: options.redact } : {}),
      ...(options.shell ? { shell: options.shell } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
    });
    if (run.spawnError) {
      results.push({
        command,
        status: "failed",
        exitCode: 127,
        summary: `could not start: ${run.spawnError.message}`,
        ...(logFile ? { log: logFile } : {}),
      });
      continue;
    }
    if (run.cancelled && !run.timedOut) {
      results.push(...checksNotRun(commands.slice(index), "not run: verification cancelled"));
      break;
    }
    const exitCode = recordedExitCode(run);
    const detail = run.timedOut
      ? ` (timed out after ${Math.round(options.timeoutMs / 1000)} s)`
      : "";
    const tail = lastNonEmptyLine(`${run.stdout}\n${run.stderr}`);
    results.push({
      command,
      status: exitCode === 0 ? "passed" : "failed",
      exitCode,
      summary: `exit ${exitCode}${detail}${tail ? `: ${tail}` : ""}`,
      durationMs: run.durationMs,
      ...(logFile ? { log: logFile } : {}),
    });
  }
  return results;
}

/**
 * Computes Birdview verification verdict: any failed check or failed execution fails the job;
 * empty checks report `unverified`, never `passed`.
 */
export function computeVerificationVerdict(input: {
  executionOk: boolean;
  checks: readonly DelegationCheckResult[];
}): { ok: boolean; verification: DelegationVerificationStatus } {
  const allPassed = input.checks.every((check) => check.status === "passed");
  const anyFailed = input.checks.some((check) => check.status === "failed");
  const verification: DelegationVerificationStatus =
    input.checks.length === 0
      ? "unverified"
      : allPassed
        ? "passed"
        : anyFailed
          ? "failed"
          : "not-run";
  return {
    ok: input.executionOk && (input.checks.length === 0 || allPassed),
    verification,
  };
}
