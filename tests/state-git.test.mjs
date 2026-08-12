import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureRepositoryFingerprint, collectReviewContext, resolveReviewTarget } from "../plugins/opencode/scripts/lib/git.mjs";
import { getProcessIdentity, terminateProcessTree } from "../plugins/opencode/scripts/lib/process.mjs";
import { listJobs, writeJob } from "../plugins/opencode/scripts/lib/state.mjs";
import { initializeRepository, makeTempDir } from "./helpers.mjs";

test("state stores workspace-specific independent job records", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
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

test("review targets reject option-like base references", () => {
  const workspace = makeTempDir();
  initializeRepository(workspace);
  assert.throws(() => resolveReviewTarget(workspace, { base: "--help" }));
});

test("untracked review context bounds file count and identifies binary files", () => {
  const workspace = makeTempDir();
  initializeRepository(workspace);
  fs.writeFileSync(path.join(workspace, "000-binary.bin"), Buffer.from([0, 1, 2]));
  for (let index = 0; index < 105; index += 1) {
    fs.writeFileSync(path.join(workspace, `untracked-${String(index).padStart(3, "0")}.txt`), `${index}\n`);
  }
  const target = resolveReviewTarget(workspace, { scope: "working-tree" });
  const context = collectReviewContext(target);
  assert.match(context, /skipped: binary file/);
  assert.match(context, /additional untracked files omitted/);
});

test("job pruning retains active jobs and caps finished history", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  writeJob(workspace, { id: "active", status: "running", createdAt: "2020-01-01T00:00:00Z" }, env);
  for (let index = 0; index < 55; index += 1) {
    writeJob(workspace, {
      id: `finished-${index}`,
      status: "completed",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    }, env);
  }
  const jobs = listJobs(workspace, env);
  assert.ok(jobs.some((job) => job.id === "active"));
  assert.equal(jobs.filter((job) => job.status === "completed").length, 50);
});

test("verified process termination escalates when SIGTERM is ignored", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  const identity = getProcessIdentity(child.pid);
  assert.ok(identity);
  terminateProcessTree(child.pid, identity);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(getProcessIdentity(child.pid), null);
});
