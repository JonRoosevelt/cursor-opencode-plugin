import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config/config.js";
import { AdapterError } from "../errors/adapterError.js";

type RunCursorInput = {
  prompt: string;
  cwd: string;
  config: AppConfig;
  resumeChatId?: string;
};

type RunCursorResult = {
  requestId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

const truncateToBytes = (value: string, maxBytes: number): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return value;
  }

  return bytes.subarray(0, maxBytes).toString("utf8");
};

export const runCursor = ({
  prompt,
  cwd,
  config,
  resumeChatId
}: RunCursorInput): Promise<RunCursorResult> =>
  new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const args = [...config.cursorBaseArgs];

    if (resumeChatId) {
      args.push("--resume", resumeChatId);
    }

    if (config.cursorPromptMode === "arg") {
      args.push(config.cursorPromptArg, prompt);
    }

    const child = spawn(config.cursorBinPath, args, {
      cwd,
      stdio: "pipe",
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settleReject = (error: AdapterError): void => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    const settleResolve = (result: RunCursorResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(result);
    };

    const timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");

      setTimeout(() => {
        child.kill("SIGKILL");
      }, 1000).unref();

      settleReject(
        new AdapterError("CURSOR_TIMEOUT", `Cursor timed out after ${config.requestTimeoutMs}ms.`, 504)
      );
    }, config.requestTimeoutMs);

    timeoutHandle.unref();

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeoutHandle);
      if (error.code === "ENOENT") {
        settleReject(
          new AdapterError(
            "CURSOR_BIN_NOT_FOUND",
            `Cursor binary not found at '${config.cursorBinPath}'.`,
            500
          )
        );
        return;
      }

      settleReject(
        new AdapterError("INTERNAL_ERROR", "Failed to start Cursor process.", 500, {
          message: error.message
        })
      );
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      stdout = truncateToBytes(stdout, config.maxStdoutBytes);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      stderr = truncateToBytes(stderr, config.maxStdoutBytes);
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);

      const durationMs = Date.now() - startedAt;
      const exitCode = code ?? -1;

      if (exitCode !== 0) {
        settleReject(
          new AdapterError("CURSOR_NON_ZERO_EXIT", `Cursor exited with status ${exitCode}.`, 502, {
            exitCode,
            stderr
          })
        );
        return;
      }

      settleResolve({
        requestId,
        stdout,
        stderr,
        exitCode,
        durationMs
      });
    });

    if (config.cursorPromptMode !== "stdin") {
      return;
    }

    child.stdin.write(prompt);
    child.stdin.end();
  });
