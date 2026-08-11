import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listJobs, writeJob } from "../plugins/opencode/scripts/lib/state.mjs";
import { fakeEnvironment, installFakeOpenCode, readFakeState } from "./fake-opencode-fixture.mjs";
import { initializeRepository, makeTempDir, runNode } from "./helpers.mjs";

const companion = path.resolve("plugins/opencode/scripts/opencode-companion.mjs");
const lifecycleHook = path.resolve("plugins/opencode/scripts/session-lifecycle-hook.mjs");

function fixture(extraEnv = {}) {
  const bin = makeTempDir();
  const pluginData = makeTempDir();
  const work = makeTempDir();
  const fake = installFakeOpenCode(bin);
  return { fake, pluginData, work, env: fakeEnvironment(fake.binary, pluginData, extraEnv) };
}

function configure(current) {
  const result = runNode(companion, [
    "configure",
    "--coder", "coder-custom",
    "--explorer", "explorer-custom",
    "--reviewer", "reviewer-custom"
  ], { cwd: current.work, env: current.env });
  assert.equal(result.status, 0, result.stderr);
}

test("setup discovers agents and reports missing assignments", () => {
  const current = fixture();
  const result = runNode(companion, ["setup", "--json"], { cwd: current.work, env: current.env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, false);
  assert.deepEqual(report.runnableAgents.map((agent) => agent.name), ["build", "coder-custom", "explorer-custom", "reviewer-custom"]);
  assert.ok(report.assignmentErrors.some((error) => /coder is not assigned/.test(error)));
});

test("configure stores only validated role-to-agent names", () => {
  const current = fixture();
  configure(current);
  const result = runNode(companion, ["setup", "--json"], { cwd: current.work, env: current.env });
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.deepEqual(report.config.roles, {
    coder: "coder-custom",
    explorer: "explorer-custom",
    reviewer: "reviewer-custom"
  });

  const invalid = runNode(companion, [
    "configure", "--coder", "coder-custom", "--explorer", "child-only", "--reviewer", "reviewer-custom"
  ], { cwd: current.work, env: current.env });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /mode subagent/);
});

test("coder uses its assigned agent and role-isolated resume", () => {
  const current = fixture();
  configure(current);
  const first = runNode(companion, ["task", "--role", "coder", "implement", "it"], { cwd: current.work, env: current.env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Completed by coder-custom/);
  assert.match(first.stdout, /ses_fake_1/);

  const resumed = runNode(companion, ["task", "--role", "coder", "--resume", "continue"], { cwd: current.work, env: current.env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Resumed OpenCode session/);
  const invocations = readFakeState(current.fake.stateFile).invocations;
  assert.equal(invocations[0].agent, "coder-custom");
  assert.ok(invocations[1].argv.includes("--session"));
});

test("explorer disables external plugins and detects repository writes", () => {
  const current = fixture({ FAKE_OPENCODE_BEHAVIOR: "write-file" });
  initializeRepository(current.work);
  configure(current);
  const result = runNode(companion, ["task", "--role", "explorer", "research"], { cwd: current.work, env: current.env });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /WARNING/);
  assert.match(result.stdout, /changed the Git repository/);
  const invocation = readFakeState(current.fake.stateFile).invocations[0];
  assert.equal(invocation.agent, "explorer-custom");
  assert.ok(invocation.argv.includes("--pure"));
});

test("reviewer receives collected Git context as an attachment", () => {
  const current = fixture();
  initializeRepository(current.work);
  fs.writeFileSync(path.join(current.work, "app.js"), "export const value = 2;\n");
  configure(current);
  const result = runNode(companion, ["review", "--scope", "working-tree", "focus", "correctness"], { cwd: current.work, env: current.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Completed by reviewer-custom/);
  const invocation = readFakeState(current.fake.stateFile).invocations[0];
  assert.equal(invocation.agent, "reviewer-custom");
  assert.equal(invocation.files.length, 1);
  assert.ok(invocation.argv.includes("--pure"));
  assert.equal(fs.existsSync(invocation.files[0]), false);
});

test("reviewer removes its sensitive context after an OpenCode error", () => {
  const current = fixture({ FAKE_OPENCODE_BEHAVIOR: "auth-error" });
  initializeRepository(current.work);
  fs.writeFileSync(path.join(current.work, "app.js"), "export const value = 2;\n");
  configure(current);
  const result = runNode(companion, ["review", "--scope", "working-tree"], { cwd: current.work, env: current.env });
  assert.notEqual(result.status, 0);
  const invocation = readFakeState(current.fake.stateFile).invocations[0];
  assert.equal(fs.existsSync(invocation.files[0]), false);
  assert.equal(listJobs(current.work, current.env)[0].temporaryDirectory, null);
});

test("background jobs can be waited on and retrieved", () => {
  const current = fixture({ FAKE_OPENCODE_BEHAVIOR: "slow" });
  configure(current);
  const launched = runNode(companion, ["task", "--role", "coder", "--background", "long", "task"], { cwd: current.work, env: current.env });
  assert.equal(launched.status, 0, launched.stderr);
  const id = launched.stdout.match(/coder-[a-z0-9-]+/i)?.[0];
  assert.ok(id);

  const waited = runNode(companion, ["status", id, "--wait", "--timeout-ms", "10000", "--json"], {
    cwd: current.work,
    env: current.env,
    timeout: 15000
  });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).status, "completed");

  const result = runNode(companion, ["result", id], { cwd: current.work, env: current.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Completed by coder-custom/);
  assert.equal(listJobs(current.work, current.env)[0].request, undefined);
});

test("active background jobs can be cancelled", () => {
  const current = fixture({ FAKE_OPENCODE_BEHAVIOR: "slow" });
  configure(current);
  const launched = runNode(companion, ["task", "--role", "coder", "--background", "cancel", "me"], { cwd: current.work, env: current.env });
  const id = launched.stdout.match(/coder-[a-z0-9-]+/i)?.[0];
  assert.ok(id);
  const cancelled = runNode(companion, ["cancel", id], { cwd: current.work, env: current.env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /Cancelled/);
  assert.equal(listJobs(current.work, current.env)[0].status, "cancelled");
});

test("status rejects a non-numeric wait timeout", () => {
  const current = fixture({ FAKE_OPENCODE_BEHAVIOR: "slow" });
  configure(current);
  const launched = runNode(companion, ["task", "--role", "coder", "--background", "long", "task"], { cwd: current.work, env: current.env });
  const id = launched.stdout.match(/coder-[a-z0-9-]+/i)?.[0];
  const status = runNode(companion, ["status", id, "--wait", "--timeout-ms", "invalid"], { cwd: current.work, env: current.env });
  assert.notEqual(status.status, 0);
  assert.match(status.stderr, /finite non-negative number/);
  runNode(companion, ["cancel", id], { cwd: current.work, env: current.env });
});

test("status reconciles a stale worker without signalling the recycled pid", () => {
  const current = fixture();
  writeJob(current.work, {
    id: "coder-stale",
    role: "coder",
    background: true,
    status: "running",
    phase: "running",
    pid: process.pid,
    processIdentity: "not-this-process",
    claudeSessionId: "claude-test-session",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, current.env);
  const status = runNode(companion, ["status", "coder-stale", "--json"], { cwd: current.work, env: current.env });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).jobs[0].status, "failed");
});

test("session end cancels only its verified background workers", () => {
  const current = fixture({ FAKE_OPENCODE_BEHAVIOR: "slow" });
  configure(current);
  const launched = runNode(companion, ["task", "--role", "coder", "--background", "long", "task"], { cwd: current.work, env: current.env });
  const id = launched.stdout.match(/coder-[a-z0-9-]+/i)?.[0];
  assert.ok(id);
  const ended = runNode(lifecycleHook, ["SessionEnd"], {
    cwd: current.work,
    env: current.env,
    input: JSON.stringify({ cwd: current.work, session_id: "claude-test-session" })
  });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(listJobs(current.work, current.env)[0].status, "cancelled");
});
