import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function removeReviewTemporaryDirectory(directory) {
  if (!directory) {
    return;
  }
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("opencode-review-")) {
    throw new Error("Refusing to remove an unexpected review temporary directory.");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
