import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureRepositoryFingerprint, resolveReviewTarget } from "../plugins/opencode/scripts/lib/git.mjs";
import { getProcessIdentity, terminateProcessTree } from "../plugins/opencode/scripts/lib/process.mjs";
import { getConfig, listJobs, saveConfig, writeJob } from "../plugins/opencode/scripts/lib/state.mjs";
import { initializeRepository, makeTempDir } from "./helpers.mjs";

test("state stores workspace-specific config and independent job records", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  saveConfig(workspace, { roles: { coder: "mine" } }, env);
  assert.equal(getConfig(workspace, env).roles.coder, "mine");
  writeJob(workspace, { id: "job-1", createdAt: "2026-01-01T00:00:00Z" }, env);
  writeJob(workspace, { id: "job-2", createdAt: "2026-01-02T00:00:00Z" }, env);
  assert.deepEqual(listJobs(workspace, env).map((job) => job.id), ["job-2", "job-1"]);
});

test("repository fingerprint detects changes to an already dirty file", () => {
  const workspace = makeTempDir();
  initializeRepository(workspace);
  const file = path.join(workspace, "app.js");
  fs.writeFileSync(file, "export const value = 2;\n");
  const before = captureRepositoryFingerprint(workspace);
  fs.writeFileSync(file, "export const value = 3;\n");
  assert.notEqual(captureRepositoryFingerprint(workspace), before);
});

test("auto review target prefers a dirty working tree", () => {
  const workspace = makeTempDir();
  initializeRepository(workspace);
  fs.writeFileSync(path.join(workspace, "new.txt"), "new\n");
  assert.equal(resolveReviewTarget(workspace, { scope: "auto" }).mode, "working-tree");
});

test("process termination refuses a mismatched process identity", () => {
  assert.ok(getProcessIdentity(process.pid));
  assert.throws(() => terminateProcessTree(process.pid, "not-this-process"), /different process/);
});

test("repository fingerprint samples large untracked files", () => {
  const workspace = makeTempDir();
  initializeRepository(workspace);
  const file = path.join(workspace, "large.bin");
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 1));
  const before = captureRepositoryFingerprint(workspace);
  fs.appendFileSync(file, Buffer.from([2]));
  assert.notEqual(captureRepositoryFingerprint(workspace), before);
});
