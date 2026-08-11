import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args, options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

export function binaryAvailable(command, args = ["--version"], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error && result.error.code === "ENOENT") {
    return { available: false, detail: `${command} was not found in PATH.` };
  }
  const detail = (result.stdout.trim() || result.stderr.trim() || `exit ${result.status}`).trim();
  return { available: result.status === 0, detail };
}

export function terminateProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("The job does not have a valid process id.");
  }
  if (process.platform === "win32") {
    const result = runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
    if (result.error || (result.status !== 0 && !/not found|no running instance/i.test(result.stderr))) {
      throw result.error ?? new Error(result.stderr.trim() || `taskkill exited ${result.status}`);
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}
