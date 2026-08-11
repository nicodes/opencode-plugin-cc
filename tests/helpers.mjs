import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function makeTempDir(prefix = "opencode-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

export function runNode(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout ?? 15000,
    maxBuffer: 16 * 1024 * 1024
  });
}

export function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

export function initializeRepository(directory) {
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.email", "test@example.com"]);
  git(directory, ["config", "user.name", "Plugin Test"]);
  fs.writeFileSync(path.join(directory, "app.js"), "export const value = 1;\n");
  git(directory, ["add", "app.js"]);
  git(directory, ["commit", "-qm", "initial"]);
}
