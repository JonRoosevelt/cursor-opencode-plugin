import { spawn } from "node:child_process";

import type { AppConfig } from "../config/config.js";
import { AdapterError } from "../errors/adapterError.js";

const UUID_REGEX =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

export const createCursorChat = (config: AppConfig, cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(config.cursorBinPath, ["create-chat"], {
      cwd,
      stdio: "pipe",
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settleResolve = (value: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };

    const settleReject = (error: AdapterError): void => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    const timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
      settleReject(
        new AdapterError(
          "CURSOR_TIMEOUT",
          `Cursor create-chat timed out after ${config.requestTimeoutMs}ms.`,
          504
        )
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

      settleReject(new AdapterError("INTERNAL_ERROR", "Failed to create Cursor chat.", 500));
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        settleReject(
          new AdapterError("CURSOR_NON_ZERO_EXIT", "Cursor create-chat failed.", 502, {
            exitCode,
            stderr
          })
        );
        return;
      }

      const match = stdout.match(UUID_REGEX);
      if (!match) {
        settleReject(
          new AdapterError("CURSOR_MALFORMED_OUTPUT", "Could not parse Cursor chat ID.", 502, {
            stdout: stdout.trim(),
            stderr: stderr.trim()
          })
        );
        return;
      }

      settleResolve(match[0]);
    });
  });
