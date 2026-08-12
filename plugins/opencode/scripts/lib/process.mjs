import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

export function getProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fields[19] ? `linux:${fields[19]}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    for (const binary of ["powershell.exe", "pwsh.exe", "pwsh"]) {
      const result = runCommand(binary, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
      ]);
      if (result.status === 0 && result.stdout.trim()) {
        return `windows:${result.stdout.trim()}`;
      }
    }
    const wmic = runCommand("wmic.exe", ["process", "where", `processid=${pid}`, "get", "CreationDate", "/value"]);
    const creationDate = wmic.stdout.match(/CreationDate=([^\r\n]+)/)?.[1]?.trim();
    return wmic.status === 0 && creationDate ? `windows-wmic:${creationDate}` : null;
  }
  const result = runCommand("ps", ["-p", String(pid), "-o", "lstart="]);
  return result.status === 0 && result.stdout.trim() ? `unix:${result.stdout.trim()}` : null;
}

export function terminateProcessTree(pid, expectedIdentity) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("The job does not have a valid process id.");
  }
  if (!expectedIdentity) {
    throw new Error("The job does not have a verifiable process identity.");
  }
  const actualIdentity = getProcessIdentity(pid);
  if (!actualIdentity) {
    throw new Error("The job process is no longer running.");
  }
  if (actualIdentity !== expectedIdentity) {
    throw new Error("The stored job process id now belongs to a different process; refusing to terminate it.");
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
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  const identityAfterGrace = getProcessIdentity(pid);
  if (identityAfterGrace && identityAfterGrace !== expectedIdentity) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}
