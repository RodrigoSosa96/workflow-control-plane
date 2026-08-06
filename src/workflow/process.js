import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

// Node reports a missing `cwd` and a missing executable with the SAME error: `spawn <cmd> ENOENT`,
// with no field distinguishing them. That collapse is actively misleading for this codebase, whose
// commands run `git` inside operator-supplied directories: `workflow merge` against a run whose
// worktree has been deleted printed "Failed to start git: spawn git ENOENT", which sends an
// operator to check their git installation when what is actually missing is the directory named
// two words earlier in the same refusal. Found running the real CLI (roadmap item 2.4, task 3,
// step 5).
//
// ENOENT is the only code that is ambiguous this way, and the `existsSync` only ever runs on that
// already-failed path -- never in the success path of any spawn. `cwd` is re-checked rather than
// assumed: by the time the error arrives, the directory really is the thing to ask about.
function startFailureMessage(command, cwd, error) {
  if (error?.code === "ENOENT" && typeof cwd === "string" && cwd && !existsSync(cwd)) {
    return `Failed to start ${command}: working directory does not exist: ${cwd}`;
  }
  return `Failed to start ${command}: ${error.message}`;
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
          reject(toProcessError(startFailureMessage(command, cwd, error), {
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
          settle(() => reject(toProcessError(startFailureMessage(command, cwd, error), {
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
