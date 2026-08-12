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

function backgroundRun(current, prompt = "long task") {
  const result = runNode(companion, ["run", "--agent", "coder-custom", "--background", prompt], { cwd: current.work, env: current.env });
  assert.equal(result.status, 0, result.stderr);
  const id = result.stdout.match(/run-[a-z0-9-]+/i)?.[0];
  assert.ok(id);
  return id;
}

test("setup discovers directly runnable agents without creating mappings", () => {
  const current = fixture();
  const result = runNode(companion, ["setup", "--json"], { cwd: current.work, env: current.env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.deepEqual(report.runnableAgents.map((agent) => agent.name), ["build", "coder-custom", "explorer-custom", "reviewer-custom"]);
  assert.deepEqual(report.errors, []);
  assert.equal("config" in report, false);
});

test("agents lists unlimited configured agents and marks subagents unavailable", () => {
  const current = fixture();
  const result = runNode(companion, ["agents", "--json"], { cwd: current.work, env: current.env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.agents.length, 5);
  assert.equal(report.agents.find((agent) => agent.name === "child-only").runnable, false);
});

test("run invokes any selected agent and resumes only matching safety mode", () => {
  const current = fixture();
  const first = runNode(companion, ["run", "--agent", "coder-custom", "implement", "it"], { cwd: current.work, env: current.env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Completed by coder-custom/);

  const wrongMode = runNode(companion, ["run", "--agent", "coder-custom", "--read-only", "--resume", "continue"], { cwd: current.work, env: current.env });
  assert.notEqual(wrongMode.status, 0);
  assert.match(wrongMode.stderr, /No completed read-only run session/);

  const wrongAgent = runNode(companion, ["run", "--agent", "explorer-custom", "--resume", "continue"], { cwd: current.work, env: current.env });
  assert.notEqual(wrongAgent.status, 0);
  assert.match(wrongAgent.stderr, /agent "explorer-custom"/);

  const resumed = runNode(companion, ["run", "--agent", "coder-custom", "--resume", "continue"], { cwd: current.work, env: current.env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Resumed OpenCode session/);
  const invocations = readFakeState(current.fake.stateFile).invocations;
  assert.equal(invocations[0].agent, "coder-custom");
  assert.ok(invocations[1].argv.includes("--session"));
});

test("run rejects unknown and subagent-mode agents", () => {
  const current = fixture();
  const child = runNode(companion, ["run", "--agent", "child-only", "task"], { cwd: current.work, env: current.env });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /mode subagent/);
  const missing = runNode(companion, ["run", "--agent", "missing", "task"], { cwd: current.work, env: current.env });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /was not found/);
});

test("explicit read-only runs disable plugins and detect repository writes", () => {
  const current = fixture({ FAKE_OPENCODE_BEHAVIOR: "write-file" });
  initializeRepository(current.work);
  const result = runNode(companion, ["run", "--agent", "explorer-custom", "--read-only", "research"], { cwd: current.work, env: current.env });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /WARNING/);
  assert.match(result.stdout, /changed the Git repository/);
  const invocation = readFakeState(current.fake.stateFile).invocations[0];
  assert.equal(invocation.agent, "explorer-custom");
  assert.ok(invocation.argv.includes("--pure"));
});

test("review sends Git context to any selected agent", () => {
  const current = fixture();
  initializeRepository(current.work);
  fs.writeFileSync(path.join(current.work, "app.js"), "export const value = 2;\n");
  const result = runNode(companion, ["review", "--agent", "reviewer-custom", "--scope", "working-tree", "focus", "correctness"], { cwd: current.work, env: current.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Completed by reviewer-custom/);
  const invocation = readFakeState(current.fake.stateFile).invocations[0];
  assert.equal(invocation.agent, "reviewer-custom");
  assert.equal(invocation.files.length, 1);
  assert.ok(invocation.argv.includes("--pure"));
  assert.equal(fs.existsSync(invocation.files[0]), false);
});

test("review removes sensitive context after an OpenCode error", () => {
  const current = fixture({ FAKE_OPENCODE_BEHAVIOR: "auth-error" });
  initializeRepository(current.work);
  fs.writeFileSync(path.join(current.work, "app.js"), "export const value = 2;\n");
  const result = runNode(companion, ["review", "--agent", "reviewer-custom", "--scope", "working-tree"], { cwd: current.work, env: current.env });
  assert.notEqual(result.status, 0);
  const invocation = readFakeState(current.fake.stateFile).invocations[0];
  assert.equal(fs.existsSync(invocation.files[0]), false);
  assert.equal(listJobs(current.work, current.env)[0].temporaryDirectory, null);
});

test("read-only runs never resume review sessions for the same agent", () => {
  const current = fixture();
  initializeRepository(current.work);
  fs.writeFileSync(path.join(current.work, "app.js"), "export const value = 2;\n");
  const review = runNode(companion, ["review", "--agent", "reviewer-custom", "--scope", "working-tree"], { cwd: current.work, env: current.env });
  assert.equal(review.status, 0, review.stderr);
  const resumed = runNode(companion, ["run", "--agent", "reviewer-custom", "--read-only", "--resume", "continue"], { cwd: current.work, env: current.env });
  assert.notEqual(resumed.status, 0);
  assert.match(resumed.stderr, /No completed read-only run session/);
});

test("resume ignores sessions created by a different Claude session", () => {
  const current = fixture();
  const first = runNode(companion, ["run", "--agent", "coder-custom", "task"], { cwd: current.work, env: current.env });
  assert.equal(first.status, 0, first.stderr);
  const otherSessionEnv = { ...current.env, OPENCODE_COMPANION_SESSION_ID: "another-claude-session" };
  const resumed = runNode(companion, ["run", "--agent", "coder-custom", "--resume", "continue"], { cwd: current.work, env: otherSessionEnv });
  assert.notEqual(resumed.status, 0);
  assert.match(resumed.stderr, /No completed run session/);
});

test("resume requires Claude session context", () => {
  const current = fixture();
  const first = runNode(companion, ["run", "--agent", "coder-custom", "task"], { cwd: current.work, env: current.env });
  assert.equal(first.status, 0, first.stderr);
  const env = { ...current.env };
  delete env.OPENCODE_COMPANION_SESSION_ID;
  const resumed = runNode(companion, ["run", "--agent", "coder-custom", "--resume", "continue"], { cwd: current.work, env });
  assert.notEqual(resumed.status, 0);
  assert.match(resumed.stderr, /requires Claude session context/);
});

test("result without an id stays within the current Claude session", () => {
  const current = fixture();
  const first = runNode(companion, ["run", "--agent", "coder-custom", "session one"], { cwd: current.work, env: current.env });
  assert.equal(first.status, 0, first.stderr);
  const otherEnv = { ...current.env, OPENCODE_COMPANION_SESSION_ID: "another-claude-session" };
  const second = runNode(companion, ["run", "--agent", "explorer-custom", "session two"], { cwd: current.work, env: otherEnv });
  assert.equal(second.status, 0, second.stderr);
  const result = runNode(companion, ["result"], { cwd: current.work, env: current.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Completed by coder-custom/);
});

test("background jobs can be waited on and retrieved", () => {
  const current = fixture({ FAKE_OPENCODE_BEHAVIOR: "slow" });
  const id = backgroundRun(current);
  const waited = runNode(companion, ["status", id, "--wait", "--timeout-ms", "10000", "--json"], {
    cwd: current.work,
    env: current.env,
    timeout: 15000
  });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).jobs[0].status, "completed");
  const result = runNode(companion, ["result", id], { cwd: current.work, env: current.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Completed by coder-custom/);
  assert.equal(listJobs(current.work, current.env)[0].request, undefined);
});

test("active background jobs can be cancelled", () => {
  const current = fixture({ FAKE_OPENCODE_BEHAVIOR: "slow" });
  const id = backgroundRun(current, "cancel me");
  const cancelled = runNode(companion, ["cancel", id], { cwd: current.work, env: current.env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(listJobs(current.work, current.env)[0].status, "cancelled");
});

test("status rejects a non-numeric wait timeout", () => {
  const current = fixture({ FAKE_OPENCODE_BEHAVIOR: "slow" });
  const id = backgroundRun(current);
  const status = runNode(companion, ["status", id, "--wait", "--timeout-ms", "invalid"], { cwd: current.work, env: current.env });
  assert.notEqual(status.status, 0);
  assert.match(status.stderr, /finite non-negative number/);
  runNode(companion, ["cancel", id], { cwd: current.work, env: current.env });
});

test("status reconciles a stale worker without signalling the recycled pid", () => {
  const current = fixture();
  writeJob(current.work, {
    id: "run-stale",
    agent: "coder-custom",
    kind: "run",
    readOnly: false,
    background: true,
    status: "running",
    phase: "running",
    pid: process.pid,
    processIdentity: "not-this-process",
    claudeSessionId: "claude-test-session",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, current.env);
  const status = runNode(companion, ["status", "run-stale", "--json"], { cwd: current.work, env: current.env });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).jobs[0].status, "failed");
});

test("session end cancels its verified background workers", () => {
  const current = fixture({ FAKE_OPENCODE_BEHAVIOR: "slow" });
  const id = backgroundRun(current);
  assert.ok(id);
  const ended = runNode(lifecycleHook, ["SessionEnd"], {
    cwd: current.work,
    env: current.env,
    input: JSON.stringify({ cwd: current.work, session_id: "claude-test-session" })
  });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(listJobs(current.work, current.env)[0].status, "cancelled");
});
