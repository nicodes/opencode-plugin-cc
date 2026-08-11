import { runCommand } from "./process.mjs";

export function resolveWorkspaceRoot(cwd) {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (!result.error && result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return cwd;
}
