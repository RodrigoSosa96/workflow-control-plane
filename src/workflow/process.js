import { spawn } from "node:child_process";
import { WorkflowError } from "./errors.js";

// Exported so a parser of a captured stream can say that its input was cut off here, rather
// than repeating the number and drifting from it.
export const OUTPUT_LIMIT = 12000;
const PROCESS_EXIT_CODE = 12;

function appendBounded(current, chunk) {
  if (current.length >= OUTPUT_LIMIT) return current;
  const text = String(chunk);
  const remaining = OUTPUT_LIMIT - current.length;
  return current + text.slice(0, remaining);
}

function toProcessError(message, details) {
  return new WorkflowError("PROCESS", message, {
    exitCode: PROCESS_EXIT_CODE,
    details,
  });
}

export function createProcessRunner({ spawnImpl = spawn } = {}) {
  return {
    async run(command, args = [], options = {}) {
      const { cwd, env, timeoutMs, allowFailure = false } = options;

      return await new Promise((resolve, reject) => {
        let child;
        try {
          child = spawnImpl(command, args, {
            cwd,
            env,
            shell: false,
          });
        } catch (error) {
          reject(toProcessError(`Failed to start ${command}: ${error.message}`, {
            reason: "spawn",
            command,
            args,
            cwd,
            stdout: "",
            stderr: "",
          }));
          return;
        }

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let timer = null;

        const settle = (callback) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          callback();
        };

        child.stdout?.on("data", (chunk) => {
          stdout = appendBounded(stdout, chunk);
        });
        child.stderr?.on("data", (chunk) => {
          stderr = appendBounded(stderr, chunk);
        });

        child.on("error", (error) => {
          settle(() => reject(toProcessError(`Failed to start ${command}: ${error.message}`, {
            reason: "spawn",
            command,
            args,
            cwd,
            stdout,
            stderr,
          })));
        });

        child.on("close", (code, signal) => {
          settle(() => {
            const result = { code: code ?? 1, stdout, stderr };

            if (signal) {
              const reason = timedOut ? "timeout" : "signal";
              const message = timedOut
                ? `${command} timed out after ${timeoutMs}ms`
                : `${command} exited with signal ${signal}`;
              reject(toProcessError(message, {
                reason,
                command,
                args,
                cwd,
                code,
                signal,
                stdout,
                stderr,
              }));
              return;
            }

            if (result.code !== 0 && !allowFailure) {
              reject(toProcessError(`${command} failed with exit code ${result.code}`, {
                reason: "exit",
                command,
                args,
                cwd,
                code: result.code,
                stdout,
                stderr,
              }));
              return;
            }

            resolve(result);
          });
        });

        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs);
        }
      });
    },
  };
}
